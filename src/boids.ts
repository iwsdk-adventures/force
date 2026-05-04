import {
  ConeGeometry,
  Color,
  createSystem,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "@iwsdk/core";

import { ForceGrabbed, ForceLifted } from "./components.js";

const BOID_COUNT = 50;

// Idle (no force active).
const MAX_SPEED_IDLE = 2.5;
const MAX_ACCEL_IDLE = 6.0;
const W_SEP = 1.4;
const W_ALI = 0.8;
const W_COH = 0.6;
const W_BOUNDS = 1.0;
const W_BOUNDS_RETURN = 2.5;
const SEP_RADIUS = 0.6;
const NEIGHBOR_RADIUS = 1.5;
const BOUND_R = 4.5;
const BOUND_Y_LOW = 0.5;
const BOUND_Y_HIGH = 3.2;

// Active (any force ability ⇒ orbit the hand).
const MAX_SPEED_ORBIT = 4.5;
const MAX_ACCEL_ORBIT = 18.0;
const FORCE_FLOCK_DAMPING = 0.2; // multiply flocking weights while a force is active.
const ORBIT_RADIUS = 0.6;
const K_RADIAL = 8.0;
const K_TANGENT = 5.0;
const FORCE_FALLOFF = 0.4; // pulls weaken slightly with distance so far boids don't overshoot.

const DT_CLAMP = 1 / 60;

const SIDE_KEY: ("left" | "right")[] = ["left", "right"];

const _toGrip = new Vector3();
const _radialDir = new Vector3();
const _tangentDir = new Vector3();
const _separation = new Vector3();
const _alignment = new Vector3();
const _cohesion = new Vector3();
const _bounds = new Vector3();
const _force = new Vector3();
const _accel = new Vector3();
const _diff = new Vector3();
const _lookDir = new Vector3();
const _matrix = new Matrix4();
const _quat = new Quaternion();
const _scale = new Vector3(1, 1, 1);
const UP = new Vector3(0, 1, 0);
const CONE_FORWARD = new Vector3(0, 1, 0);

interface Boid {
  pos: Vector3;
  vel: Vector3;
}

export class BoidSystem extends createSystem({
  grabbed: { required: [ForceGrabbed] },
  lifted: { required: [ForceLifted] },
}) {
  private boids: Boid[] = [];
  private mesh!: InstancedMesh;
  private gripPoints: Vector3[] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private gripCount = 0;

  init() {
    const geometry = new ConeGeometry(0.04, 0.1, 6);
    geometry.translate(0, 0.05, 0);
    const material = new MeshStandardMaterial({
      color: new Color(0xa8b4d0),
      roughness: 0.6,
      metalness: 0.0,
      emissive: new Color(0xa8b4d0),
      emissiveIntensity: 0.18,
    });
    this.mesh = new InstancedMesh(geometry, material, BOID_COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.name = "BoidFlock";
    this.scene.add(this.mesh);

    for (let i = 0; i < BOID_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.8 + Math.random() * 2.2;
      const pos = new Vector3(
        Math.cos(angle) * radius,
        0.8 + Math.random() * 2.0,
        Math.sin(angle) * radius - 0.5,
      );
      const vel = new Vector3(
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 2,
      );
      this.boids.push({ pos, vel });
    }
    this.writeMatrices();
  }

  update(deltaSeconds: number) {
    const dt = Math.min(deltaSeconds, DT_CLAMP);

    // Collect distinct grip points for active force entities.
    // Multiple bodies on the same controller share one grip; dedupe by side.
    const sideSeen = [false, false];
    this.gripCount = 0;
    for (const e of this.queries.grabbed.entities) {
      const side = e.getValue(ForceGrabbed, "side") ?? -1;
      if (side < 0 || sideSeen[side]) continue;
      const grip = this.player.gripSpaces[SIDE_KEY[side]];
      if (!grip) continue;
      grip.getWorldPosition(this.gripPoints[this.gripCount]);
      this.gripCount++;
      sideSeen[side] = true;
    }
    for (const e of this.queries.lifted.entities) {
      const side = e.getValue(ForceLifted, "side") ?? -1;
      if (side < 0 || sideSeen[side]) continue;
      const grip = this.player.gripSpaces[SIDE_KEY[side]];
      if (!grip) continue;
      grip.getWorldPosition(this.gripPoints[this.gripCount]);
      this.gripCount++;
      sideSeen[side] = true;
    }
    const forceActive = this.gripCount > 0;
    const flockMult = forceActive ? FORCE_FLOCK_DAMPING : 1.0;
    const maxSpeed = forceActive ? MAX_SPEED_ORBIT : MAX_SPEED_IDLE;
    const maxAccel = forceActive ? MAX_ACCEL_ORBIT : MAX_ACCEL_IDLE;

    for (let i = 0; i < BOID_COUNT; i++) {
      const me = this.boids[i];

      _separation.set(0, 0, 0);
      _alignment.set(0, 0, 0);
      _cohesion.set(0, 0, 0);
      let alignCount = 0;
      let cohesionCount = 0;

      for (let j = 0; j < BOID_COUNT; j++) {
        if (i === j) continue;
        const other = this.boids[j];
        _diff.subVectors(me.pos, other.pos);
        const distSq = _diff.lengthSq();
        if (distSq < 1e-6) continue;
        const dist = Math.sqrt(distSq);
        if (dist < SEP_RADIUS) {
          _separation.addScaledVector(_diff, 1 / (dist * dist));
        }
        if (dist < NEIGHBOR_RADIUS) {
          _alignment.add(other.vel);
          _cohesion.add(other.pos);
          alignCount++;
          cohesionCount++;
        }
      }
      if (alignCount > 0) _alignment.divideScalar(alignCount).sub(me.vel);
      if (cohesionCount > 0) _cohesion.divideScalar(cohesionCount).sub(me.pos);

      // Bounds — only when no force is active (otherwise orbit can pull boids freely).
      _bounds.set(0, 0, 0);
      if (!forceActive) {
        const horizontalR = Math.hypot(me.pos.x, me.pos.z + 0.5);
        if (horizontalR > BOUND_R) {
          _bounds
            .set(-me.pos.x, 0, -(me.pos.z + 0.5))
            .normalize()
            .multiplyScalar((horizontalR - BOUND_R) * W_BOUNDS_RETURN);
        }
        if (me.pos.y < BOUND_Y_LOW) _bounds.y += (BOUND_Y_LOW - me.pos.y) * 6;
        if (me.pos.y > BOUND_Y_HIGH) _bounds.y -= (me.pos.y - BOUND_Y_HIGH) * 6;
      }

      // Gravity-orbit force toward each active grip.
      _force.set(0, 0, 0);
      for (let g = 0; g < this.gripCount; g++) {
        const grip = this.gripPoints[g];
        _toGrip.subVectors(grip, me.pos);
        const r = _toGrip.length();
        if (r < 1e-3) continue;
        _radialDir.copy(_toGrip).divideScalar(r);

        // Shell snap: positive shellGap means too far → pull in; negative → push out.
        const shellGap = r - ORBIT_RADIUS;
        const radialMag = (shellGap * K_RADIAL) / (1 + r * FORCE_FALLOFF);
        _force.addScaledVector(_radialDir, radialMag);

        // Tangential push perpendicular to radial in horizontal plane.
        _tangentDir.crossVectors(_radialDir, UP);
        const tangLenSq = _tangentDir.lengthSq();
        if (tangLenSq < 1e-4) {
          // Boid directly above/below grip: pick an arbitrary horizontal tangent.
          _tangentDir.set(1, 0, 0);
        } else {
          _tangentDir.divideScalar(Math.sqrt(tangLenSq));
        }
        _force.addScaledVector(_tangentDir, K_TANGENT / (1 + r * FORCE_FALLOFF));
      }

      _accel
        .set(0, 0, 0)
        .addScaledVector(_separation, W_SEP * flockMult)
        .addScaledVector(_alignment, W_ALI * flockMult)
        .addScaledVector(_cohesion, W_COH * flockMult)
        .addScaledVector(_bounds, W_BOUNDS)
        .add(_force);
      if (_accel.lengthSq() > maxAccel * maxAccel) _accel.setLength(maxAccel);

      me.vel.addScaledVector(_accel, dt);
      if (me.vel.lengthSq() > maxSpeed * maxSpeed) me.vel.setLength(maxSpeed);
      me.pos.addScaledVector(me.vel, dt);
    }

    this.writeMatrices();
  }

  private writeMatrices() {
    for (let i = 0; i < BOID_COUNT; i++) {
      const me = this.boids[i];
      _lookDir.copy(me.vel);
      if (_lookDir.lengthSq() < 1e-4) {
        _lookDir.set(0, 1, 0);
      } else {
        _lookDir.normalize();
      }
      _quat.setFromUnitVectors(CONE_FORWARD, _lookDir);
      _matrix.compose(me.pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
