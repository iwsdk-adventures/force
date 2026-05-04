# Force Sandbox — Lessons from the build

Distilled patterns and gotchas from the WebXR force-sandbox build (Claude Opus 4.7, 16 user turns / 519 tool calls / 24 checkpoint screenshots, ~2h 20m of active work spread over a 16-hour wall-clock window with one large idle gap, 5 plan-mode iterations: v1 scaffold + force grab/lift mechanics → v2 visual retune + cylinder collider fix + UI panel + reset → v3 28 props + 4× throw + lightning rays + boid flock + lighter floor → v4 panel flex layout + brighter IBL + orbit boids + hand visual (reverted) → v5 vendored AnimatedControllerHand). This file is the curated signal; `session.jsonl` next to it is the full transcript and `checkpoints/.../*.png` are the screenshots that paid for each lesson.

This is not a force-sandbox tutorial. It is what an IWSDK dev would have wanted to know *before* implementing physics-only telekinesis abilities, building a curved-Bezier lightning ray system, and integrating a 50-boid flock simulation alongside Havok rigid bodies — including two real IWSDK 0.3.2 bugs that only surface once you stray off the well-trodden path.

---

## Before you start

**Plan-mode iteration was the right cadence here too.** Five plan files were approved (with one rejection mid-R2 that recovered cleanly), each addressing one round of user feedback as a focused diff. R1 was the spec-driven scaffold; R2 was "dark/cold/cone-shaped/no rays"; R3 was "more props, throw harder, lightning rays, boids, grey floor"; R4 was "panel overflow / IBL too dark / boid swarm / hand visual"; R5 was "vendor and patch the hand visual." Each plan was 100–250 lines, not a rewrite. Editing the existing plan file in place per re-enter-plan-mode is correct; do not start fresh on continuations. Same lesson as the target-practice build, validated again.

**Read source — do not trust .d.ts when behavior is wrong.** Two of this build's most painful bugs were diagnosed by reading the runtime `.js` in `node_modules/@iwsdk/`, not the public `.d.ts`. (1) The cylinder collider mismatch only became obvious after reading `physics-system.js:188` and seeing `HP_Shape_CreateCylinder([0,0,0], [0,h,0], r)` — a one-line confirmation that the collider spans y∈[0,h], not centered. (2) The `AnimatedControllerHand` crash diagnosis required comparing `animated-controller-hand.js:316` (broken: declares `(model, scene, camera, layout)`) against `animated-controller.js:11` (works: `super(...arguments)`) against `base-visual-adapter.js:79` (calls `new visualClass(scene, camera, gltf.scene, layout)`). The `.d.ts` lied about both signatures. JS is the source of truth.

**Subagent fan-out for API research at iteration boundaries.** Each plan started with 2–3 parallel `Explore` agents on focused questions: *"how do I render lines in WebXR?"*, *"how do boid systems integrate with IWSDK ECS?"*, *"diagnose this AnimatedControllerHand stack trace."* The agents read source, returned ~600-word reports with file paths, and the plan was concrete because of it. The cost was minutes; the savings was not having to backtrack after committing to the wrong primitive. Fits the same pattern as target-practice's `iwsdk-planner` skill load — front-load API knowledge before the first Write.

---

## Physics in IWSDK (the most expensive lessons)

**`features.grabbing: true` is mandatory if you have any `PhysicsBody` entities, even if you never use IWSDK's grab system.** First reload after R1 build crashed every frame: `TypeError: Cannot read properties of null (reading 'words') at _BitSet.intersects ... at PhysicsSystem.update`. Diagnosis: `physics-system.js:124` calls `entity.hasComponent(Grabbed)` for every physics body to honor IWSDK's "grabbed bodies follow target transform" path; `Grabbed` is registered inside `GrabSystem.init()` (`grab-system.js:93`) which is only registered when `features.grabbing` is truthy. With grabbing off, `Grabbed` doesn't exist in the world's component registry, the bitset lookup hits null, and every physics tick crashes. Setting `features: { grabbing: true, physics: true }` registers `Grabbed` as a side effect; my own systems never use IWSDK's grab system but the physics path doesn't crash. Treat `grabbing: true` as a prerequisite of `physics: true` for now.

**`gravityFactor` and `linearDamping` on `PhysicsBody` are read once at body creation. They are not reactive.** Confirmed by reading `physics-system.js:104` and `:188` — both fields are passed to `createBody` and into `HP_Body_SetGravityFactor` / `HP_Body_SetLinearDamping` when the Havok body is first instantiated. There's no per-frame sync. The spec called for "save and restore gravityFactor while held" — that's not implementable through the component. The workaround is to bake the inverse-gravity term into the per-frame applied force: `force.y += mass * 9.81` while the body is held, and *also* compute the spring-damper as if gravity didn't exist. Same pattern works for damping — write your own `−vel × c` damping force into the manipulation rather than fighting the engine's internal damping.

**`PhysicsShapeType.Cylinder` has a half-height visual/collider offset.** `HP_Shape_CreateCylinder([0, 0, 0], [0, height, 0], radius)` builds the collider spanning y∈[0, height] in local space, but Three.js `CylinderGeometry` is centered at origin (y∈[−h/2, +h/2]). The mesh and the collider are offset by h/2. Symptoms: a grabbed cylinder bobs irregularly around its anchor (because torque from collisions is computed against the wrong origin), and dropped cylinders rest h/2 above the floor surface. **The same bug hits the floor itself** if you use a Cylinder collider for a flat disc — props rest at `dais_top + r` shifted by the floor's half-height. Two fixes:
- For dynamic props with cylinder/cone meshes: switch to `PhysicsShapeType.ConvexHull`. The convex hull is built from the actual mesh vertices, so it's self-centering. Performance is fine for low-poly primitives.
- For static floor/dais (cylindrical mesh, flat use): switch to `PhysicsShapeType.Box` with dimensions `[diameter, height, diameter]`. A box is centered correctly; the corners-poking-past-the-disc area is invisible at the working camera angles since props live above the disc face.

`PhysicsShapeType.Auto` does not save you here — it routes `CylinderGeometry` to `PhysicsShapeType.Cylinder`, which has the bug. Auto is only "safe" for `SphereGeometry` and `BoxGeometry`. Worse: `ConeGeometry` extends `CylinderGeometry`, so `Auto` would mis-classify cones as cylinders with averaged radius. Always set the shape type explicitly for cylinders and cones.

**Spawning a small dynamic prop *inside* a static collider produces invisible chaos.** A radius-0.07 sphere spawned at `y = 0.07` over the dais (whose Box collider spans `y ∈ [0, 0.15]`) starts inside the collider. Havok's penetration resolution kicks in at the first physics tick — but the box has no preferred escape direction, so the sphere sometimes gets pushed *down* through the floor below it (whose collider is below the dais), settling at `y = −0.07` half-buried. Symptoms in `ecs_query_entity`: the prop's Y is a small negative number, orientation is identity, velocity zero. Visually: the prop is half-sunken into the floor. Fix: per-prop, compute the bounding-box max-Y of any static collider whose XZ footprint overlaps the prop's XZ position, and set the prop spawn-Y to `that_max + prop_half_height + epsilon`. Don't bury props in the dais.

**`PhysicsManipulation.force` is a one-frame impulse that the system removes after applying.** Re-add the component every frame for sustained force. `physics-system.js:143` (`manipluatedEntities` query) processes `PhysicsManipulation` and calls `entity.removeComponent(PhysicsManipulation)` at the end of each tick. Setting `force` does `HP_Body_ApplyImpulse(body, pos, [f.x*delta, f.y*delta, f.z*delta])` — so `force` is in Newtons (not impulse units), and the engine multiplies by `delta` internally. Setting `linearVelocity` instead overrides velocity directly. The grab-throw release uses both in sequence: while held, force-only manipulation each frame; on release, replace with a one-shot `linearVelocity`-only manipulation.

**System priority: `−3` for targeting, `−2.5` for ability mutation, `−2` for `PhysicsSystem`.** Targeting (cone hover test) reads pose and writes `ForceHovered` tags first. Ability systems (grab, lift) read `ForceHovered`/`ForceGrabbed`/`ForceLifted`, compute force vectors, write `PhysicsManipulation`. PhysicsSystem at `-2` consumes manipulation, steps Havok, syncs `Object3D.position` from the body buffer. Everything else (highlight, force-ray render, boid sim) runs at default 0, after physics, so it sees the post-step pose.

---

## Custom rendering inside IWSDK

**`Line2 + LineGeometry + LineMaterial` from `three/examples/jsm/lines/` is the right primitive for world-space thick lines.** IWSDK already uses this trio for its teleport arc (`@iwsdk/core/dist/locomotion/teleport.js`), confirmed working in WebXR on Quest. Stock Three.js exports work fine — IWSDK's internal `LineMaterial` fork is in a non-exported subpath and not worth the deep import. Setup:

```ts
const geometry = new LineGeometry();
geometry.setPositions(new Float32Array(SAMPLES * 3));
geometry.setColors(new Float32Array(SAMPLES * 3)); // per-vertex gradient
const material = new LineMaterial({
  linewidth: 0.005, worldUnits: true, vertexColors: true,
  transparent: true, depthWrite: false,
});
material.blending = AdditiveBlending;
const line = new Line2(geometry, material);
line.frustumCulled = false; // line ends move per frame; frustum culling is wrong
```

Per-frame update is `geometry.setPositions(positions)` — positions is a reused Float32Array, no allocation. Pool 8 grab-rays + 16 lift-rays at init; toggle `line.visible` based on which slots are active.

**Quadratic Bezier with `P1 = P0 + handTangent × controlOffset` makes a curve that "leaves the hand" naturally.** `P0` = ray-space world origin (the hand position), `P2` = target object center, `P1` = `P0 + rayDir × 0.6 × |P0−P2|` clamped to [0.4, 2.0] m. The tangent at `t=0` is `2(P1 − P0) = 2 × controlOffset × rayDir`, which points along the controller's pointing direction — so the curve emerges straight from the hand and bends toward the target. User had a strong opinion on this exact behavior ("it will start in the direction of my target ray space and then it will curve towards the objects") and the math nailed it on the first try. Keep this pattern in the toolbox for any curved-leash visual.

**Lightning jitter: `amp × sin(πt)` perpendicular displacement, refresh seed every 3 frames.** Endpoints (`t=0`, `t=1`) are kept un-jittered so the line stays anchored to hand and target. Middle samples are displaced in the plane perpendicular to the segment direction; pre-compute the basis once per ray with Gram-Schmidt off the ray axis. Re-rolling the random angles every frame *vibrates* (looks like a wireframe error). Re-rolling every 3 frames *crackles* (reads as electrical). Tunable per mode: grab amp 0.04 m + 4 mm width = focused leash; lift amp 0.10 m + 2.5 mm width = wider tendril. One ray pool, two tunings.

**`InstancedMesh` is the right primitive for N=50 boids; one ECS entity holds the InstancedMesh, an internal `Boid[]` array drives state.** No precedent in IWSDK source for this pattern but it composes cleanly. Per-tick: simulate flocking on the `Boid[]`, then `mesh.setMatrixAt(i, matrix)` for all i, then `mesh.instanceMatrix.needsUpdate = true`. `Quaternion.setFromUnitVectors(CONE_FORWARD_LOCAL, velocityNormalized)` orients each instance along its velocity. With 50 boids the O(N²) flock kernel is 2500 distance checks per frame — trivial, no spatial hashing. The mesh entity is parented to `world.activeLevel.value` and survives the `resetProps` call (which only destroys force-eligible props). Keep boid state independent of game-state resets.

---

## Visual: dome and IBL are independent

**`DomeGradient` writes `scene.background`; `IBLGradient` writes `scene.environment` — they are totally decoupled.** First instinct (and what R1–R3 did) was to use the same colors and intensity for both. The user pushed back on R3 (`"the dome background and IBL lighting are actually separately controlled"`) and was right. The dark twilight dome is atmospheric for the visible sky; the *lighting* on the props comes from `IBLGradient.intensity × scene.environmentIntensity` and can be much brighter. Final settings:
- `DomeGradient`: dark twilight, intensity 1.0, untouched after R3.
- `IBLGradient`: brighter mid-grey/blue colors at intensity 1.5 (briefly tried 2.2 — too bright per user feedback). Decoupling these gives "dark atmospheric sky, brightly lit props" — the look of a stylized stage at night.

The `intensity` field on both components has no engine clamp; sensible range is roughly 0.5–4.0. Intensity 2.2 made the floor read near-white; 1.5 reads as a properly-lit mid-grey. Visual feedback is the only way to find the right value — start at 2.0, tune from there.

**Hex-color literals in the dome/IBL components don't work — they want `[r, g, b, a]` floats.** Field type is `Types.Color` which stores 4-float RGBA. Hex `0x141a26` is fine for `MeshStandardMaterial.color` (which accepts both forms via Three.js Color), but `setValue(DomeGradient, "sky", 0x141a26)` doesn't do what you expect — pass `[0.078, 0.102, 0.149, 1.0]` instead. (Equivalent: `new Color(0x141a26).toArray()` plus a 1.0 alpha.)

---

## UIKit panels: nested inline elements break

**`<span class="key">X</span> — text` inside a `<span class="line">` doesn't lay out — use a flex `<div class="row">` with two `<span>` children instead.** R3's panel had each mode-line as `<span class="mode-line"><span class="mode-key">Trigger</span> — Force Grab. ...</span>`; the rendered output had stray glyphs and the text overflowed the panel. UIKit's flow layout doesn't recover from inline-inside-inline well in 0.3.2. Fix:

```html
<div class="mode-row">
  <span class="mode-key">Trigger</span>
  <span class="mode-text">Force Grab — aim, pull one object to your palm.</span>
</div>
```

with `.mode-text { flex-grow: 1; flex-shrink: 1; min-width: 0 }` — the `min-width: 0` is the part that lets the text-wrap inside a flex child instead of overflowing the parent. This is also where text wraps cleanly in plain CSS flexbox; UIKit follows the spec on this. Default `min-width: auto` would push the text to its intrinsic width and overflow.

**Reset Scene works by `entity.dispose()` + re-spawn, not by writing positions.** IWSDK exposes no public way to set a Havok body's position at runtime (no `setQTransform` on the component). The clean reset is: track every spawned prop in a module-level `liveProps: Entity[]`, call `e.dispose()` for each (which calls `destroy()` underneath, which triggers PhysicsSystem's `disqualify` subscriber on `physicsEntities` — that subscriber calls `HP_World_RemoveBody` and `HP_Shape_Release`), clear the array, then call `spawnProps(world)` again. Verified by `ecs_find_entities { withComponents: ["ForceEligible"] }` returning the same count after reset, with reused entity indices showing different prop names — the old props were truly destroyed, the new ones built fresh. No Havok body leak.

---

## IWSDK 0.3.2 bug: `AnimatedControllerHand` constructor parameter order is wrong

**The d.ts lies and the constructor crashes. Vendor with the right parameter order.** This was the longest-running bug of the build and worth a deep entry.

The call site in `XRInputVisualAdapter.createVisual` (`@iwsdk/xr-input/dist/visual/adapter/base-visual-adapter.js:79`):

```js
visual = new visualClass(scene, camera, gltf.scene, layout);
```

`BaseControllerVisual` (`base-impl.js:7`) accepts `(scene, camera, model, layout)` and stores them on `this.{scene, camera, model, layout}`. ✓ Matches.

`AnimatedController` (the working default — `animated-controller.js:11`) just does `super(...arguments)`. It works regardless of parameter naming because the spread passes through.

`AnimatedControllerHand` (`animated-controller-hand.js:316–319`) declares its constructor as:
```js
constructor(model, scene, camera, layout) {
  super(scene, camera, model, layout);
  ...
  const skinnedMesh = model.getObjectByProperty('type', 'SkinnedMesh');  // model is actually `scene`
  skinnedMesh.frustumCulled = false;  // → undefined.frustumCulled
```

Inside, `model` is bound to the call-site's `scene` (the THREE.Scene), and `getObjectByProperty('SkinnedMesh')` returns nothing on the Scene. The crash is one line later. The author wrote the parameter list in the order the d.ts implies (model first), but the call site passes them in BaseControllerVisual order. Author error, ships in 0.3.2.

The fix is unavoidable: vendor the class. `BaseControllerVisual` is in a non-exported subpath (`base-impl.d.ts`), so subclassing requires a deep import and the bug is *inside* the constructor anyway. Vendored as `src/animatedControllerHand.ts` — copy the 300-line pose tables verbatim, inline the 25-line BaseControllerVisual functionality (stores fields, toggles visibility, no-ops for `init`/`update`), fix the constructor signature to `(scene, camera, model, layout)`, pass `super(scene, camera, model, layout)` (or just store directly on `this`). All other behavior unchanged. Header-comment the file as `VENDORED FROM @iwsdk/xr-input — REMOVE WHEN UPSTREAM FIXES THE CONSTRUCTOR PARAMETER ORDER`.

The hand-bone names and pose data are fine; the asset URL `https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/{handedness}.glb` is correct; the rest of the constructor logic (skinned mesh material swap, wrist-distance attribute, bone hookup) all works once `model` is actually the GLTF root.

---

## Debugging at frame-by-frame

**`ecs_pause` → state-change → `ecs_step(N)` → `browser_screenshot` is the only practical pattern for sub-second physics events.** Force grab transition fires on a single frame's trigger-down edge; the grabbed body's spring-damper takes ~30 frames to settle near the anchor; the throw impulse fires on the trigger-up edge and propagates as one velocity write. Without pause/step you can't observe any of these distinctly. The pattern from target-practice generalizes verbatim:

1. `ecs_pause`
2. `ecs_snapshot { label: "before" }`
3. `xr_set_select_value { device, value: 1 }` — queue trigger-down edge
4. `ecs_step { count: 1 }` — one frame: ForceGrabSystem detects press, adds ForceGrabbed
5. `ecs_diff { from: "before", to: "after" }` — confirms the component diff
6. `ecs_step { count: 30 }` — settle
7. `ecs_query_entity` — confirm position near predicted anchor

Validated R1's grab + throw and lift + drop end-to-end this way. Don't try to time it with real-time playback.

**Throw velocity needs two physics frames after release to read on `_linearVelocity`.** PhysicsSystem reads body velocity from Havok *before* applying any new `PhysicsManipulation` in the same frame. So the throw-impulse frame's component view still shows the pre-throw velocity; the next frame shows the new one. Caused 5 minutes of "throw is broken" panic on R1 validation; resolved by stepping one more frame.

**`browser_get_console_logs` returns the entire log buffer including pre-reload entries — filter by `since`.** Multiple rounds of debugging started with "wait, there's still a frustumCulled error" only to notice the timestamp was minutes before the latest reload. `since: <recent epoch-ms>` is the right filter. Grab `date +%s%3N` (note: macOS BSD `date` doesn't support `%3N`; use `node -e 'console.log(Date.now())'` if precision matters, or just look at the log timestamps and pick a known-recent one).

**Hard reload (`browser_reload_page` then `xr_accept_session`) is two MCP calls — make it reflexive after every code change.** Vite HMR is fine for the first 2–3 changes but builds up stale module-graph state. After each `Edit` to a system file, reload + re-accept-session before screenshotting. ~3 seconds total.

**Visual verification of orbit/flock behavior wants a 3–5-second wait.** Boids take ~0.5s to stream toward the hand and form an orbit; releasing takes another second to disperse. `Bash sleep 3` between state change and screenshot was the right cadence. For instant effects (grab ray appearing on trigger-down), single-frame step + screenshot works.

---

## Specific gotchas this build earned

**Use `raySpaces` not `gripSpaces` for the cone *axis*.** First force-targeting attempt used `gripSpace.getWorldQuaternion()` and applied to `(0,0,-1)` to compute the cone axis. Pointing the controller at a target gave 0 ForceHovered hits. Diagnosis via `scene_get_object_transform` on individual XR-origin children: the IWER controller pose drives `raySpace`, but `gripSpace` has its own offset (the "pistol-grip" tilt of the controller) — so the grip's local-forward is *not* the pointing direction. The fix: use `gripSpace` for the cone *apex* (where the player feels their hand to be) and `raySpace` for the *axis* direction (the visible pointer direction). Spec called this out with `"the cone axis is the controller's pointing direction — the same direction along which the visible pointer ray is cast"` — read the spec.

**`InputComponent.Trigger` and `InputComponent.Squeeze` are string IDs (`"xr-standard-trigger"`, `"xr-standard-squeeze"`), not button indices.** The IWER MCP tool `xr_set_gamepad_state` takes button *indices* (0=trigger, 1=squeeze). The IWSDK gamepad accessor `gamepad.getButtonDown(InputComponent.Trigger)` takes the string ID. Translation:
- `xr_set_select_value(value: 1)` → IWSDK reads as `getButtonDown(Trigger)` true on the next frame.
- `xr_set_gamepad_state(buttons: [{ index: 1, value: 1 }])` → IWSDK reads as `getButtonDown(Squeeze)` true.

Worth a sticky note above the validation tools.

**`world.input.visualAdapters.controller.{left,right}.updateVisualImplementation(klass)` is the API to swap controller visuals.** Documented nowhere in the public exports — found by reading `xr-input-manager.d.ts:48` and `base-visual-adapter.d.ts:53`. `world.input` is the `XRInputManager`; `visualAdapters.controller.left/right` are `XRControllerVisualAdapter` instances; `updateVisualImplementation(VisualConstructor)` swaps the class. The swap takes effect on the next input-source connection.

**4× throw boost feels right; 7 m/s velocity cap was too low.** Spec said `THROW_BOOST = 4 m/s`, `THROW_VELOCITY_CAP = 7 m/s`. After R3 the user wanted "at least 4× the current value" — bumped boost to 16 m/s, cap to 22 m/s. Walls (TriMesh) and floor (Box) handled the higher velocities without tunneling at this scale. Don't be afraid to raise the cap when game-feel demands it, especially in a small enclosed scene.

**The IBL / environment-reflection lighting completely changes the read of saturated pastel colors.** R1's pink atrium with full-pink IBL looked like everything was lit by the same flat-pink light source — props blended into the walls. Switching to dark IBL (R2) made the props pop but the scene felt underlit. The R4 fix (decouple IBL from dome, brighter mid-grey IBL) was the visual-language win that finally made the scene read. The trick is to think of the IBL as the ambient light source's *color*, not a global tint — props sitting on a dark stage still need brightly-lit ambient to read their own colors.

---

## What didn't work so well

**R1 "build a dream gradient atrium with pink pastels" was a loss.** The user explicitly asked for the concept image's pastel-pink palette but didn't actually want it once they saw it — "the color scheme is also so pink, lets actually not do that." The first 14-prop scene was scrap-and-rebuild for R2. Lesson: reference images set color *temperature* and *mood*, not a literal palette. Confirm the mood next time before locking the palette.

**R3's boid behavior was too subtle on first pass.** Originally split into two modes (grab = weak attract, lift = swirl) with a "mostly normal flocking with light force-field reaction" feel. User feedback: not noticeable enough. R4 collapsed it to a single strong "gravitational orbit" that activates whenever any force ability is on — boids stream in from across the room and form a fast horizontal disc-orbit at 0.6 m radius around the hand. The lesson: VR perception is *less* sensitive than a 2D screen, not more. Crank reactive effects until they read; physically realistic is invisible.

**Tried to fix the `AnimatedControllerHand` crash by reverting in R4 — should have vendored on the first attempt.** The user explicitly asked for the hand visual; reverting was a regression. Vendoring on R5 was 30 minutes of work (mostly mechanical pose-data copy). Should have skipped the revert and gone straight to vendor when the upstream class crashed. When a public-API class has an obvious-on-inspection bug and the use case is non-negotiable, vendor first, ask later.

**`as any` cast on `updateVisualImplementation(AnimatedControllerHand)` papered over the constructor signature mismatch and propagated the runtime crash.** First R4 attempt typed the cast away; the d.ts wanted `(model, scene, camera, layout)` but the runtime needed `(scene, camera, model, layout)` to actually work, and the cast hid the conflict from tsc. Constructor signatures in declaration files are load-bearing — if the cast is the only way to make it compile, it's papering over a real type lie. Better to hit the type error, investigate, and fix at the source.

**Spent ~10 minutes confused by stale Vite HMR errors.** The "Cannot read properties of null (reading 'words')" trace appeared in `browser_get_console_logs` *after* the fix; only the timestamp revealed it was from before the reload. Reflexive `since: <recent ts>` filter would have saved the time.

---

## Pointers into `session.jsonl`

The full session transcript is alongside this file. JSONL is one event per line — go to the line number directly.

| # | Lesson | Line(s) |
|---|---|---|
| 1 | First plan written + ExitPlanMode (R1 spec scaffold) | 27 |
| 2 | Initial user spec ("execute spec.md, disregard environment") | 5 |
| 3 | First parallel `Explore` fan-out (physics API + interaction patterns + scene state) | 16, 18, ... |
| 4 | Discovered `gravityFactor`/`linearDamping` are body-creation-only by reading `physics-system.js:104,188` | 34, 36 |
| 5 | First R1 reload crash — `_BitSet.intersects` on null `Grabbed` mask | 134 |
| 6 | Diagnosis: `Grabbed` registered inside `GrabSystem.init`; flipped `features.grabbing: true` | 125, 145 |
| 7 | First successful screenshot (R1 — pastel atrium with arches/pillars) | 156 |
| 8 | User feedback after R1: "remove arches, dark/cold, no pink, fix cylinder collider" | 262 |
| 9 | Read `physics-system.js:188` and confirmed `HP_Shape_CreateCylinder([0,0,0], [0,h,0], r)` offset bug | (search for `HP_Shape_CreateCylinder` in turn 2) |
| 10 | R2 plan rejected — user wanted UI panel back with reset button | 269 |
| 11 | R2 re-plan approved (panel + collider + colors) | 277 |
| 12 | R2 wrap-up: cylinder grabbed, settled at predicted anchor (verified `centerOfMass ≈ 0`) | 362 |
| 13 | R3 plan approved (28 props, 4× throw, lightning, boids, grey floor) | 372 |
| 14 | Bezier + lightning ray system landed | (turn 3 forceRay implementation) |
| 15 | Boid `InstancedMesh` flock landed | (turn 3 boids implementation) |
| 16 | Discovered 4 small props spawn inside dais collider, fall through floor | 427 |
| 17 | R4 plan approved (panel layout, brighter IBL, orbit boids, hand visual) | 475 |
| 18 | First `AnimatedControllerHand` swap — `frustumCulled` crash | (turn 4 reload after hand swap) |
| 19 | Reverted hand swap to keep R4 shippable | (turn 4 revert) |
| 20 | User feedback: "is there no way we can patch the hand issue?" | 560 |
| 21 | R5 plan approved (vendor + fix AnimatedControllerHand) | 570 |
| 22 | Vendored class with corrected `(scene, camera, model, layout)` constructor | (turn 6 Write) |
| 23 | Final validation: hands visible, trigger animates fingers, orbit boids react | (turn 6 last screenshots) |
| 24 | "It's a touch too bright" — IBL intensity 2.2 → 1.5 (turn 5 single-line tune) | 550 |
