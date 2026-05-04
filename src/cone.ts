import { Vector3 } from "@iwsdk/core";

export const NARROW_CONE = {
  length: 5.0,
  tanHalfAngle: Math.tan((4.6 * Math.PI) / 180),
};

export const WIDE_CONE = {
  length: 2.5,
  tanHalfAngle: Math.tan((31 * Math.PI) / 180),
};

const _toCenter = new Vector3();
const _proj = new Vector3();
const _perp = new Vector3();

export function isInCone(
  apex: Vector3,
  axis: Vector3,
  length: number,
  tanHalfAngle: number,
  candidateCenter: Vector3,
  candidateRadius: number,
): { inCone: boolean; distance: number } {
  _toCenter.subVectors(candidateCenter, apex);
  const t = _toCenter.dot(axis);
  if (t < -candidateRadius || t > length + candidateRadius) {
    return { inCone: false, distance: Infinity };
  }
  _proj.copy(axis).multiplyScalar(t);
  _perp.subVectors(_toCenter, _proj);
  const perpDist = _perp.length();
  const allowed = Math.max(t, 0) * tanHalfAngle + candidateRadius;
  return {
    inCone: perpDist <= allowed,
    distance: _toCenter.length(),
  };
}
