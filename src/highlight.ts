import {
  createSystem,
  Mesh,
  MeshStandardMaterial,
} from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";

import { ForceEligible, ForceGrabbed, ForceHovered, ForceLifted } from "./components.js";

const HOVER_INTENSITY = 0.45;
const HELD_INTENSITY = 0.75;

function eachStandardMaterial(
  entity: Entity,
  fn: (m: MeshStandardMaterial) => void,
) {
  entity.object3D?.traverse((child) => {
    const mesh = child as Mesh;
    if ((mesh as any).isMesh) {
      const mat = mesh.material as MeshStandardMaterial | MeshStandardMaterial[];
      if (Array.isArray(mat)) {
        for (const m of mat) if ((m as any).isMeshStandardMaterial) fn(m);
      } else if ((mat as any).isMeshStandardMaterial) {
        fn(mat);
      }
    }
  });
}

export class HighlightSystem extends createSystem({
  hovered: { required: [ForceHovered, ForceEligible] },
  grabbed: { required: [ForceGrabbed, ForceEligible] },
  lifted: { required: [ForceLifted, ForceEligible] },
}) {
  private originals = new Map<number, number>();

  init() {
    this.queries.hovered.subscribe("qualify", (e) => this.boost(e, HOVER_INTENSITY));
    this.queries.hovered.subscribe("disqualify", (e) => this.restore(e));
    this.queries.grabbed.subscribe("qualify", (e) => this.boost(e, HELD_INTENSITY));
    this.queries.grabbed.subscribe("disqualify", (e) => this.restore(e));
    this.queries.lifted.subscribe("qualify", (e) => this.boost(e, HELD_INTENSITY));
    this.queries.lifted.subscribe("disqualify", (e) => this.restore(e));
  }

  private boost(entity: Entity, target: number) {
    if (!this.originals.has(entity.index)) {
      let original = 0;
      eachStandardMaterial(entity, (m) => {
        original = m.emissiveIntensity;
      });
      this.originals.set(entity.index, original);
    }
    eachStandardMaterial(entity, (m) => {
      m.emissiveIntensity = target;
    });
  }

  private restore(entity: Entity) {
    if (
      entity.hasComponent(ForceGrabbed) ||
      entity.hasComponent(ForceLifted) ||
      entity.hasComponent(ForceHovered)
    ) {
      return;
    }
    const original = this.originals.get(entity.index) ?? 0.05;
    eachStandardMaterial(entity, (m) => {
      m.emissiveIntensity = original;
    });
    this.originals.delete(entity.index);
  }

  update() {}
}
