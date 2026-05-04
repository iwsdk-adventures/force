import { createComponent, Types } from "@iwsdk/core";

export const ForceEligible = createComponent("ForceEligible", {
  density: { type: Types.Float32, default: 1.0 },
  shapeKind: { type: Types.Int8, default: 0 },
  dimX: { type: Types.Float32, default: 0 },
  dimY: { type: Types.Float32, default: 0 },
  dimZ: { type: Types.Float32, default: 0 },
});

export const SHAPE_SPHERE = 0;
export const SHAPE_BOX = 1;
export const SHAPE_CYLINDER = 2;
export const SHAPE_CONE = 3;

export const ForceHovered = createComponent("ForceHovered", {
  side: { type: Types.Int8, default: -1 },
});

export const ForceGrabbed = createComponent("ForceGrabbed", {
  side: { type: Types.Int8, default: -1 },
  mass: { type: Types.Float32, default: 1 },
});

export const ForceLifted = createComponent("ForceLifted", {
  side: { type: Types.Int8, default: -1 },
  originHeight: { type: Types.Float32, default: 0 },
  referenceHandHeight: { type: Types.Float32, default: 0 },
  mass: { type: Types.Float32, default: 1 },
});

export function massFromShape(
  shapeKind: number,
  dimX: number,
  dimY: number,
  dimZ: number,
  density: number,
): number {
  let volume = 1;
  if (shapeKind === SHAPE_SPHERE) {
    volume = (4 / 3) * Math.PI * dimX * dimX * dimX;
  } else if (shapeKind === SHAPE_BOX) {
    volume = dimX * dimY * dimZ;
  } else if (shapeKind === SHAPE_CYLINDER) {
    volume = Math.PI * dimX * dimX * dimY;
  } else if (shapeKind === SHAPE_CONE) {
    volume = (1 / 3) * Math.PI * dimX * dimX * dimY;
  }
  return Math.max(0.001, volume * density);
}
