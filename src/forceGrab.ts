import {
  createSystem,
  InputComponent,
  PhysicsBody,
  PhysicsManipulation,
  Quaternion,
  Vector3,
} from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";

import {
  ForceEligible,
  ForceGrabbed,
  ForceHovered,
  ForceLifted,
  massFromShape,
} from "./components.js";

const FORWARD = new Vector3(0, 0, -1);
const ANCHOR_DISTANCE = 1.0;
const SPRING_STIFFNESS = 60;
const DAMPING_COEFFICIENT = 12;
const MAX_FORCE = 80;
// Throw is intentionally strong; cap raised to 22 m/s trades tunneling safety for game-feel.
// Walls are TriMesh and floor is Box — both robust enough to take a single-step impulse at this speed.
const THROW_BOOST = 16.0;
const THROW_VELOCITY_CAP = 22.0;
const GRAVITY = 9.81;

const _gripPos = new Vector3();
const _gripQuat = new Quaternion();
const _axis = new Vector3();
const _anchor = new Vector3();
const _bodyPos = new Vector3();
const _spring = new Vector3();
const _damp = new Vector3();
const _total = new Vector3();
const _vel = new Vector3();
const _throw = new Vector3();

type Side = "left" | "right";
const SIDES: Side[] = ["left", "right"];
const SIDE_INDEX: Record<Side, number> = { left: 0, right: 1 };

export class ForceGrabSystem extends createSystem({
  hovered: { required: [ForceHovered, ForceEligible] },
  grabbed: { required: [ForceGrabbed, ForceEligible, PhysicsBody] },
  lifted: { required: [ForceLifted] },
}) {
  update() {
    for (const side of SIDES) {
      const sideIdx = SIDE_INDEX[side];
      const grip = this.player.gripSpaces[side];
      const ray = this.player.raySpaces[side];
      const gamepad = this.input.gamepads[side];
      if (!grip || !ray) continue;

      grip.getWorldPosition(_gripPos);
      ray.getWorldQuaternion(_gripQuat);
      _axis.copy(FORWARD).applyQuaternion(_gripQuat).normalize();

      // 1. Press detection — Idle → Grabbing.
      if (gamepad?.getButtonDown(InputComponent.Trigger)) {
        const lifting = this.isSideLifting(sideIdx);
        if (!lifting) {
          const target = this.findHoveredForSide(sideIdx);
          if (target) {
            const density = target.getValue(ForceEligible, "density") ?? 1;
            const shapeKind = target.getValue(ForceEligible, "shapeKind") ?? 0;
            const dimX = target.getValue(ForceEligible, "dimX") ?? 0;
            const dimY = target.getValue(ForceEligible, "dimY") ?? 0;
            const dimZ = target.getValue(ForceEligible, "dimZ") ?? 0;
            const mass = massFromShape(shapeKind, dimX, dimY, dimZ, density);
            target.removeComponent(ForceHovered);
            target.addComponent(ForceGrabbed, { side: sideIdx, mass });
          }
        }
      }

      // 2. Hold tick — apply spring-damper + gravity comp force.
      _anchor.copy(_axis).multiplyScalar(ANCHOR_DISTANCE).add(_gripPos);
      for (const entity of this.queries.grabbed.entities) {
        if (entity.getValue(ForceGrabbed, "side") !== sideIdx) continue;
        const obj = entity.object3D;
        if (!obj) continue;
        obj.getWorldPosition(_bodyPos);
        const velView = entity.getVectorView(PhysicsBody, "_linearVelocity");
        _vel.set(velView[0], velView[1], velView[2]);

        _spring.subVectors(_anchor, _bodyPos).multiplyScalar(SPRING_STIFFNESS);
        _damp.copy(_vel).multiplyScalar(-DAMPING_COEFFICIENT);
        _total.copy(_spring).add(_damp);

        const mass = entity.getValue(ForceGrabbed, "mass") ?? 1;
        _total.y += mass * GRAVITY;

        const mag = _total.length();
        if (mag > MAX_FORCE) _total.multiplyScalar(MAX_FORCE / mag);

        // PhysicsSystem applies force * delta as impulse; scale up to compensate
        // (force is meant to be N; engine multiplies by dt internally).
        // Reading physics-system.js: HP_Body_ApplyImpulse(body, pos, [f.x*dt, f.y*dt, f.z*dt])
        // So f represents force in Newtons — no further scaling needed.
        if (entity.hasComponent(PhysicsManipulation)) {
          entity.removeComponent(PhysicsManipulation);
        }
        entity.addComponent(PhysicsManipulation, {
          force: [_total.x, _total.y, _total.z],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        });
      }

      // 3. Release detection — Grabbing → Idle, throw impulse.
      if (gamepad?.getButtonUp(InputComponent.Trigger)) {
        const owned: Entity[] = [];
        for (const entity of this.queries.grabbed.entities) {
          if (entity.getValue(ForceGrabbed, "side") === sideIdx) owned.push(entity);
        }
        for (const entity of owned) {
          const velView = entity.getVectorView(PhysicsBody, "_linearVelocity");
          _vel.set(velView[0], velView[1], velView[2]);
          _throw.copy(_axis).multiplyScalar(THROW_BOOST).add(_vel);
          const mag = _throw.length();
          if (mag > THROW_VELOCITY_CAP) {
            _throw.multiplyScalar(THROW_VELOCITY_CAP / mag);
          }
          if (entity.hasComponent(PhysicsManipulation)) {
            entity.removeComponent(PhysicsManipulation);
          }
          entity.addComponent(PhysicsManipulation, {
            force: [0, 0, 0],
            linearVelocity: [_throw.x, _throw.y, _throw.z],
            angularVelocity: [0, 0, 0],
          });
          entity.removeComponent(ForceGrabbed);
        }
      }
    }
  }

  private isSideLifting(sideIdx: number): boolean {
    for (const e of this.queries.lifted.entities) {
      if (e.getValue(ForceLifted, "side") === sideIdx) return true;
    }
    return false;
  }

  private findHoveredForSide(sideIdx: number): Entity | null {
    for (const e of this.queries.hovered.entities) {
      if (e.getValue(ForceHovered, "side") === sideIdx) return e;
    }
    return null;
  }
}
