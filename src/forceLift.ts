import {
  createSystem,
  InputComponent,
  Mesh,
  PhysicsBody,
  PhysicsManipulation,
  Quaternion,
  Sphere,
  Vector3,
} from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";

import {
  ForceEligible,
  ForceGrabbed,
  ForceLifted,
  ForceHovered,
  massFromShape,
} from "./components.js";
import { isInCone, WIDE_CONE } from "./cone.js";

const FORWARD = new Vector3(0, 0, -1);
const LIFT_OFFSET = 0.3;
const SPRING_STIFFNESS = 30;
const DAMPING_COEFFICIENT = 8;
const MAX_FORCE = 40;
const GRAVITY = 9.81;

const _gripPos = new Vector3();
const _gripQuat = new Quaternion();
const _axis = new Vector3();
const _bodyPos = new Vector3();
const _vel = new Vector3();
const _sphereWorld = new Sphere();

type Side = "left" | "right";
const SIDES: Side[] = ["left", "right"];
const SIDE_INDEX: Record<Side, number> = { left: 0, right: 1 };

function getMeshBoundingSphereWorld(entity: Entity): Sphere | null {
  const obj = entity.object3D;
  if (!obj) return null;
  let found: Mesh | null = null;
  obj.traverse((c) => {
    if (!found && (c as Mesh).isMesh) found = c as Mesh;
  });
  if (!found) return null;
  const mesh = found as Mesh;
  const geom = mesh.geometry;
  if (!geom.boundingSphere) geom.computeBoundingSphere();
  if (!geom.boundingSphere) return null;
  _sphereWorld.copy(geom.boundingSphere);
  mesh.updateWorldMatrix(true, false);
  _sphereWorld.center.applyMatrix4(mesh.matrixWorld);
  const scale = mesh.matrixWorld.getMaxScaleOnAxis();
  _sphereWorld.radius *= scale;
  return _sphereWorld;
}

export class ForceLiftSystem extends createSystem({
  eligible: { required: [ForceEligible] },
  grabbed: { required: [ForceGrabbed] },
  lifted: { required: [ForceLifted, ForceEligible, PhysicsBody] },
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

      // 1. Press detection — Idle → Lifting (selection freezes here).
      if (gamepad?.getButtonDown(InputComponent.Squeeze)) {
        const grabbing = this.isSideGrabbing(sideIdx);
        if (!grabbing) {
          const referenceHandHeight = _gripPos.y;
          for (const entity of this.queries.eligible.entities) {
            if (entity.hasComponent(ForceGrabbed)) continue;
            if (entity.hasComponent(ForceLifted)) continue;
            const sphere = getMeshBoundingSphereWorld(entity);
            if (!sphere) continue;
            const result = isInCone(
              _gripPos,
              _axis,
              WIDE_CONE.length,
              WIDE_CONE.tanHalfAngle,
              sphere.center,
              sphere.radius,
            );
            if (!result.inCone) continue;

            const obj = entity.object3D!;
            obj.getWorldPosition(_bodyPos);

            const density = entity.getValue(ForceEligible, "density") ?? 1;
            const shapeKind = entity.getValue(ForceEligible, "shapeKind") ?? 0;
            const dimX = entity.getValue(ForceEligible, "dimX") ?? 0;
            const dimY = entity.getValue(ForceEligible, "dimY") ?? 0;
            const dimZ = entity.getValue(ForceEligible, "dimZ") ?? 0;
            const mass = massFromShape(shapeKind, dimX, dimY, dimZ, density);

            if (entity.hasComponent(ForceHovered)) {
              entity.removeComponent(ForceHovered);
            }
            entity.addComponent(ForceLifted, {
              side: sideIdx,
              originHeight: _bodyPos.y,
              referenceHandHeight,
              mass,
            });
          }
        }
      }

      // 2. Hold tick — Y-axis spring-damper + gravity comp.
      const currentHandY = _gripPos.y;
      for (const entity of this.queries.lifted.entities) {
        if (entity.getValue(ForceLifted, "side") !== sideIdx) continue;
        const obj = entity.object3D;
        if (!obj) continue;
        obj.getWorldPosition(_bodyPos);
        const velView = entity.getVectorView(PhysicsBody, "_linearVelocity");
        _vel.set(velView[0], velView[1], velView[2]);

        const originHeight = entity.getValue(ForceLifted, "originHeight") ?? 0;
        const referenceHandHeight =
          entity.getValue(ForceLifted, "referenceHandHeight") ?? 0;
        const mass = entity.getValue(ForceLifted, "mass") ?? 1;

        const targetY =
          originHeight + (currentHandY - referenceHandHeight) + LIFT_OFFSET;
        const springY = (targetY - _bodyPos.y) * SPRING_STIFFNESS;
        const dampY = -_vel.y * DAMPING_COEFFICIENT;
        const gravComp = mass * GRAVITY;
        let forceY = springY + dampY + gravComp;
        if (forceY > MAX_FORCE) forceY = MAX_FORCE;
        if (forceY < -MAX_FORCE) forceY = -MAX_FORCE;

        if (entity.hasComponent(PhysicsManipulation)) {
          entity.removeComponent(PhysicsManipulation);
        }
        entity.addComponent(PhysicsManipulation, {
          force: [0, forceY, 0],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        });
      }

      // 3. Release detection — Lifting → Idle. No impulse; bodies fall.
      if (gamepad?.getButtonUp(InputComponent.Squeeze)) {
        const owned: Entity[] = [];
        for (const entity of this.queries.lifted.entities) {
          if (entity.getValue(ForceLifted, "side") === sideIdx) owned.push(entity);
        }
        for (const entity of owned) {
          entity.removeComponent(ForceLifted);
        }
      }
    }
  }

  private isSideGrabbing(sideIdx: number): boolean {
    for (const e of this.queries.grabbed.entities) {
      if (e.getValue(ForceGrabbed, "side") === sideIdx) return true;
    }
    return false;
  }
}
