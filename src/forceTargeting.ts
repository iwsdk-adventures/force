import {
  createSystem,
  Mesh,
  Quaternion,
  Sphere,
  Vector3,
} from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";

import {
  ForceEligible,
  ForceGrabbed,
  ForceHovered,
  ForceLifted,
} from "./components.js";
import { isInCone, NARROW_CONE } from "./cone.js";

const FORWARD = new Vector3(0, 0, -1);

const _gripPos = new Vector3();
const _gripQuat = new Quaternion();
const _axis = new Vector3();
const _sphereWorld = new Sphere();
const _meshWorldPos = new Vector3();

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
  // Approximate radius scale: take max scale axis.
  mesh.getWorldPosition(_meshWorldPos); // ensure matrix updated
  const scale = mesh.matrixWorld.getMaxScaleOnAxis();
  _sphereWorld.radius *= scale;
  return _sphereWorld;
}

export class ForceTargetingSystem extends createSystem({
  eligible: { required: [ForceEligible] },
  hovered: { required: [ForceHovered] },
  grabbed: { required: [ForceGrabbed] },
  lifted: { required: [ForceLifted] },
}) {
  update() {
    for (const side of SIDES) {
      const sideIdx = SIDE_INDEX[side];
      const grip = this.player.gripSpaces[side];
      const ray = this.player.raySpaces[side];
      if (!grip || !ray) continue;

      const busy = this.isSideBusy(sideIdx);
      // Clear this side's hover before re-resolving (or on busy).
      for (const e of this.queries.hovered.entities) {
        if (e.getValue(ForceHovered, "side") === sideIdx) {
          e.removeComponent(ForceHovered);
        }
      }
      if (busy) continue;

      grip.getWorldPosition(_gripPos);
      ray.getWorldQuaternion(_gripQuat);
      _axis.copy(FORWARD).applyQuaternion(_gripQuat).normalize();

      let bestEntity: Entity | null = null;
      let bestDistance = Infinity;
      for (const e of this.queries.eligible.entities) {
        if (e.hasComponent(ForceGrabbed) || e.hasComponent(ForceLifted)) continue;
        const sphere = getMeshBoundingSphereWorld(e);
        if (!sphere) continue;
        const result = isInCone(
          _gripPos,
          _axis,
          NARROW_CONE.length,
          NARROW_CONE.tanHalfAngle,
          sphere.center,
          sphere.radius,
        );
        if (result.inCone && result.distance < bestDistance) {
          bestDistance = result.distance;
          bestEntity = e;
        }
      }

      if (bestEntity) {
        bestEntity.addComponent(ForceHovered, { side: sideIdx });
      }
    }
  }

  private isSideBusy(sideIdx: number): boolean {
    for (const e of this.queries.grabbed.entities) {
      if (e.getValue(ForceGrabbed, "side") === sideIdx) return true;
    }
    for (const e of this.queries.lifted.entities) {
      if (e.getValue(ForceLifted, "side") === sideIdx) return true;
    }
    return false;
  }
}
