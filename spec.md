# Force Sandbox — Technical Spec

A small VR physics sandbox themed around telekinesis. The player stands in a room with assorted props — some resting on the floor, some pre-suspended in mid-air — and uses two distinct telekinetic abilities to manipulate them. Both abilities are implemented entirely as physics forces on rigid bodies. No code path ever writes a body's position or rotation directly. Walls, scenery, and other rigid bodies therefore always block manipulated objects naturally, with no special-case logic.

## Player abilities

There are two abilities, each bound to a different button on the same controller. They are mutually exclusive: whichever button is pressed first wins, and the other input is ignored until the first releases.

### Ability A — Force Grab (trigger button)
A targeted, single-object pull. One rigid body is selected from a narrow cone projected from the controller and is held at a moving anchor point one meter in front of the controller along its pointing direction. The body follows the anchor by a spring-damper force, not by direct positioning. Releasing the trigger applies a forward impulse — a "throw."

### Ability B — Force Lift (grip button)
An area-of-effect lift. Every eligible rigid body inside a wider, shorter cone in front of the hand has its gravity neutralized and is pushed vertically toward a target height that tracks the controller's height. Holding the grip lifts the bodies; raising the hand raises them; lowering the hand lowers them; releasing the grip restores gravity and the bodies fall.

## Force-eligibility

Only a subset of rigid bodies in the scene are "force-eligible." These are the only bodies the targeting subsystem considers and the only ones whose physics state may be mutated by either ability. The room shell, floor, scenery, and the player collider are not eligible. This bounds query cost (cones iterate over the eligible set, never the full scene) and prevents the player from accidentally lifting the room.

## Shared targeting subsystem

Both abilities use cone-shaped intersection queries against the eligible set. The cone apex is the controller's grip position (where the user perceives their hand to be). The cone axis is the controller's pointing direction — the same direction along which the visible pointer ray is cast, which on most VR hardware is tilted slightly downward from the grip's local forward.

Per-object intersection is accelerated by a precomputed bounding volume hierarchy (BVH) built over each candidate's triangle mesh. The runtime already maintains BVH structures on interactable meshes for ray-pointer hit-testing, so this subsystem reuses the same acceleration data. Bodies that are not force-eligible are simply absent from the candidate set; no BVH query is performed on the room shell or scenery.

Two cone profiles share the targeting code; only the geometric parameters differ.

| Profile | Length (apex to far cap) | Far-cap radius | Half-angle (approx.) | Used by |
|---|---|---|---|---|
| Narrow / long | 5.0 m | 0.4 m | 4.6° | Force Grab |
| Wide / short  | 2.5 m | 1.5 m | 31° | Force Lift |

A candidate body is considered in-cone when, after projecting its closest point onto the cone axis, the projected distance from the apex falls within the cone length and the perpendicular distance from the axis falls within `projected_distance × tan(half_angle)`. The BVH query refines this beyond a center-point test when bodies have spatially extended geometry.

### Hover targeting (continuous, while no ability is active)

The narrow cone runs once per render tick whenever the controller is in its idle state. The closest in-cone candidate, ranked by Euclidean distance from the candidate's center of mass to the controller grip, is given a "hovered" mark. A material highlight (such as an emissive boost) is applied to the hovered body and removed when the hover changes. This is the player's only feedback for which body the trigger will pick up; it must always be present whenever the trigger is a meaningful action.

The wide cone is not used for ambient hover (the highlight noise from sweeping a 31° cone across the room would be unreadable). It is evaluated only at the instant the grip button is pressed.

## Ability A — Force Grab

### Selection

Triggered on trigger-press. The body that was hovered at that instant becomes the grabbed body. If nothing was hovered, the press is consumed without effect — there is no fallback search.

The hover and the grab share the same selection rule: the body whose center of mass has the smallest Euclidean distance to the controller grip position, among all bodies whose mesh BVH intersects the narrow cone.

### Hold dynamics

When a body is grabbed:
- Its gravity factor is set to zero. The original value is saved.
- Its linear damping is raised. The original value is saved.

The anchor point is recomputed every physics tick as `controller_grip_position + controller_pointing_direction × 1.0 m`. The anchor distance is fixed at one meter. There is no "distance frozen at grab time."

For each tick the body is held:
- A spring-damper force is computed:
  - Spring term: `(anchor_position − body_position) × spring_stiffness`
  - Damping term: `− body_linear_velocity × damping_coefficient`
  - Total: their sum
- The total force vector's magnitude is clamped to a maximum. This clamp is essential: when the anchor enters geometry the body cannot reach (a wall, another rigid body), an unclamped spring would generate unbounded force and drive the body through the obstacle in a single integration step.
- The clamped force is applied to the body as an external force for that tick. It is not written as a velocity or position.

Because the body's pose is never written by the ability, all interactions with the world are mediated by the rigid body solver. The anchor can be inside a wall — the body will press against the wall surface but cannot pass through it. The body can collide with other dynamic bodies and push them.

Initial tuning, assuming SI units and a representative body mass of 1 kg:

| Parameter | Value |
|---|---|
| Anchor distance from controller | 1.0 m |
| Spring stiffness | 60 N/m |
| Damping coefficient | 12 N·s/m |
| Max applied force magnitude | 80 N |
| Linear damping override (engine units) | 4.0 |

The damping coefficient is chosen near critical damping (`2 × sqrt(stiffness × mass)`) so the body settles toward the anchor without overshoot.

### Release (throw)

On trigger-release:
- The body's gravity factor and linear damping are restored from their saved values.
- A throw impulse is applied: a constant forward boost (e.g., 4 m/s) added to the body's existing linear velocity, along the controller's pointing direction at the moment of release.
- The held mark is removed.

The resulting linear velocity should be capped at a value within the simulator's continuous collision tolerance (e.g., 7 m/s). Without a cap, a player who whips the controller hard immediately before release can produce a velocity that tunnels the body through one wall in a single integration step.

## Ability B — Force Lift

### Selection

Triggered on grip-press. The wide cone resolves all eligible in-cone bodies *at this single instant only*. The cone is not re-resolved on subsequent ticks; the lifted set is fixed for the duration of the grip hold. Re-resolving each tick would cause bodies to pop in and out of the lift as the hand swept through the scene, which feels unstable.

Selection excludes any body currently held by Ability A on either controller.

At the moment of selection:
- The current controller grip Y-coordinate is recorded as the reference hand height.
- For each body in the resolved set:
  - The body's current Y-coordinate is recorded as its origin height.
  - The body's gravity factor and linear damping are saved, then overridden (gravity factor zeroed; linear damping raised).
  - The body is given a "lifted" mark that retains its origin height, the reference hand height, and its saved factors for the duration of the grip hold.

### Lift dynamics

For each tick the grip is held, for every lifted body:
- The current controller grip Y-coordinate is read.
- A target height for the body is computed as `body_origin_height + (current_hand_height − reference_hand_height) + lift_offset`, where the lift offset is a small constant so that pressing grip with the hand at rest still lifts bodies clear of the floor.
- A 1-D spring-damper force is computed on the Y-axis only: spring term plus damping term, exactly as in Ability A but using the height target rather than a 3-D anchor.
- The Y-component is clamped, then applied as a force vector with zero X and Z components. Horizontal motion is left entirely to the rigid body solver.

The result is that bodies float vertically toward their tracked target height, while their horizontal motion settles through ordinary physics — bodies that bump each other or a wall horizontally are resolved by the solver, not by special logic.

Initial tuning:

| Parameter | Value |
|---|---|
| Cone length | 2.5 m |
| Cone far-cap radius | 1.5 m |
| Lift offset | 0.3 m |
| Spring stiffness | 30 N/m |
| Damping coefficient | 8 N·s/m |
| Max applied force magnitude (Y only) | 40 N |
| Linear damping override | 3.0 |

Lift stiffness is intentionally lower than grab stiffness — slow vertical bobbing reads as "telekinetic field" rather than as latency.

### Release (drop)

On grip-release:
- For each currently-lifted body: its gravity factor and linear damping are restored, the lifted mark is removed.
- No impulse is applied. Bodies fall under restored gravity from wherever they were when the grip was released.

## Per-controller state machine

The controller is in one of three states: Idle, Grabbing, Lifting.

Transitions:
- Idle → Grabbing on trigger-press if a hovered body exists.
- Idle → Lifting on grip-press if at least one body is in the wide cone.
- Idle → Idle on either button-press if the corresponding selection set is empty.
- Grabbing → Idle on trigger-release. The throw impulse fires during this transition.
- Lifting → Idle on grip-release. The drop happens during this transition.
- While in Grabbing or Lifting, input from the other button is ignored.

The hover-targeting query runs only in the Idle state.

## Engine prerequisites

The spec assumes the underlying physics runtime provides:
- A discrete rigid body simulator with per-body linear and angular velocity.
- Per-body gravity factor, or an equivalent way to disable gravity on an individual body without affecting the rest of the scene.
- Per-body linear damping that can be overridden at runtime.
- Application of an external force vector to a single body for a single integration step.
- A precomputed BVH per collision mesh, queryable for cone or ray intersection.
- Either continuous collision detection on dynamic bodies, or an enforceable maximum velocity to prevent tunneling.
- A deterministic update order for systems so that targeting, ability logic, the physics step, and state-read happen in a known sequence each tick.

## Open tuning decisions

These should be evaluated by feel during implementation and tuning:

1. Whether the throw impulse should incorporate a fraction of the controller's recent linear velocity (so a flick adds energy beyond the constant boost), or remain a pure forward boost. Pure forward is the safer default.
2. Whether the wide-cone selection in Ability B should freeze at grip-press (the current spec) or re-resolve each tick. Freezing is more stable; re-resolving is more flexible but visually busy.
3. Whether Ability B should additionally apply a weak horizontal spring pulling bodies toward the controller's axis, producing a "vortex" feel. The default spec applies vertical force only.
