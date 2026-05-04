import {
  AdditiveBlending,
  Color,
  createSystem,
  Quaternion,
  Vector3,
} from "@iwsdk/core";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import { ForceGrabbed, ForceLifted } from "./components.js";

const SAMPLES = 24;
const GRAB_AMP = 0.04;
const LIFT_AMP = 0.1;
const GRAB_LINEWIDTH = 0.005;
const LIFT_LINEWIDTH = 0.0035;
const GRAB_COLOR_START = new Color(0x9bd8ff);
const GRAB_COLOR_END = new Color(0xffffff);
const LIFT_COLOR_START = new Color(0xffc56a);
const LIFT_COLOR_END = new Color(0xffe7b8);
const GRAB_POOL = 8;
const LIFT_POOL = 16;

const FORWARD = new Vector3(0, 0, -1);
const _quat = new Quaternion();
const _start = new Vector3();
const _end = new Vector3();
const _control = new Vector3();
const _rayDir = new Vector3();
const _segDir = new Vector3();
const _perpA = new Vector3();
const _perpB = new Vector3();
const _ref = new Vector3();
const _samplePoint = new Vector3();
const _bezierA = new Vector3();
const _bezierB = new Vector3();

const SIDE_KEY: ("left" | "right")[] = ["left", "right"];

type RayKind = "grab" | "lift";

interface RayHandle {
  line: Line2;
  geometry: LineGeometry;
  positions: Float32Array;
  inUse: boolean;
}

function quadraticBezier(
  p0: Vector3,
  p1: Vector3,
  p2: Vector3,
  t: number,
  out: Vector3,
): Vector3 {
  const u = 1 - t;
  out.copy(p0).multiplyScalar(u * u);
  _bezierA.copy(p1).multiplyScalar(2 * u * t);
  _bezierB.copy(p2).multiplyScalar(t * t);
  out.add(_bezierA).add(_bezierB);
  return out;
}

function buildPerpendicularBasis(axis: Vector3): void {
  if (Math.abs(axis.y) < 0.9) {
    _ref.set(0, 1, 0);
  } else {
    _ref.set(1, 0, 0);
  }
  _perpA.copy(_ref).sub(_segDir.copy(axis).multiplyScalar(_ref.dot(axis))).normalize();
  _perpB.copy(axis).cross(_perpA).normalize();
}

export class ForceRaySystem extends createSystem({
  grabbed: { required: [ForceGrabbed] },
  lifted: { required: [ForceLifted] },
}) {
  private grabPool: RayHandle[] = [];
  private liftPool: RayHandle[] = [];
  private frameCount = 0;
  private cachedAngles: number[] = [];

  init() {
    for (let i = 0; i < GRAB_POOL; i++) {
      this.grabPool.push(this.createRay("grab"));
    }
    for (let i = 0; i < LIFT_POOL; i++) {
      this.liftPool.push(this.createRay("lift"));
    }
    for (let i = 0; i < SAMPLES; i++) {
      this.cachedAngles.push(Math.random() * Math.PI * 2);
    }
  }

  private createRay(kind: RayKind): RayHandle {
    const positions = new Float32Array(SAMPLES * 3);
    const colors = new Float32Array(SAMPLES * 3);
    const colorStart = kind === "grab" ? GRAB_COLOR_START : LIFT_COLOR_START;
    const colorEnd = kind === "grab" ? GRAB_COLOR_END : LIFT_COLOR_END;
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1);
      colors[i * 3] = colorStart.r * (1 - t) + colorEnd.r * t;
      colors[i * 3 + 1] = colorStart.g * (1 - t) + colorEnd.g * t;
      colors[i * 3 + 2] = colorStart.b * (1 - t) + colorEnd.b * t;
    }
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const material = new LineMaterial({
      linewidth: kind === "grab" ? GRAB_LINEWIDTH : LIFT_LINEWIDTH,
      worldUnits: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      alphaToCoverage: false,
    });
    material.blending = AdditiveBlending;
    const line = new Line2(geometry, material);
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 999;
    this.scene.add(line);
    return { line, geometry, positions, inUse: false };
  }

  update() {
    this.frameCount++;
    if (this.frameCount % 3 === 0) {
      for (let i = 0; i < SAMPLES; i++) {
        this.cachedAngles[i] = Math.random() * Math.PI * 2;
      }
    }

    for (const r of this.grabPool) r.inUse = false;
    for (const r of this.liftPool) r.inUse = false;

    let grabIdx = 0;
    for (const entity of this.queries.grabbed.entities) {
      if (grabIdx >= this.grabPool.length) break;
      const side = entity.getValue(ForceGrabbed, "side") ?? -1;
      if (side < 0 || !entity.object3D) continue;
      const ray = this.player.raySpaces[SIDE_KEY[side]];
      if (!ray) continue;

      ray.getWorldPosition(_start);
      ray.getWorldQuaternion(_quat);
      _rayDir.copy(FORWARD).applyQuaternion(_quat).normalize();
      entity.object3D.getWorldPosition(_end);

      const handle = this.grabPool[grabIdx++];
      handle.inUse = true;
      this.fillRay(handle, GRAB_AMP);
      handle.line.visible = true;
    }

    let liftIdx = 0;
    for (const entity of this.queries.lifted.entities) {
      if (liftIdx >= this.liftPool.length) break;
      const side = entity.getValue(ForceLifted, "side") ?? -1;
      if (side < 0 || !entity.object3D) continue;
      const ray = this.player.raySpaces[SIDE_KEY[side]];
      if (!ray) continue;

      ray.getWorldPosition(_start);
      ray.getWorldQuaternion(_quat);
      _rayDir.copy(FORWARD).applyQuaternion(_quat).normalize();
      entity.object3D.getWorldPosition(_end);

      const handle = this.liftPool[liftIdx++];
      handle.inUse = true;
      this.fillRay(handle, LIFT_AMP);
      handle.line.visible = true;
    }

    for (const r of this.grabPool) if (!r.inUse) r.line.visible = false;
    for (const r of this.liftPool) if (!r.inUse) r.line.visible = false;
  }

  // _start, _end, _rayDir set by caller; updates handle's geometry.
  private fillRay(handle: RayHandle, amp: number) {
    const distance = _start.distanceTo(_end);
    const controlOffset = Math.min(2.0, Math.max(0.4, distance * 0.6));
    _control.copy(_rayDir).multiplyScalar(controlOffset).add(_start);

    _segDir.copy(_end).sub(_start).normalize();
    buildPerpendicularBasis(_segDir);

    const positions = handle.positions;
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1);
      quadraticBezier(_start, _control, _end, t, _samplePoint);
      if (i > 0 && i < SAMPLES - 1) {
        const shape = Math.sin(Math.PI * t);
        const angle = this.cachedAngles[i] + this.frameCount * 0.13;
        const offsetX = Math.cos(angle) * amp * shape;
        const offsetY = Math.sin(angle) * amp * shape;
        _samplePoint.addScaledVector(_perpA, offsetX);
        _samplePoint.addScaledVector(_perpB, offsetY);
      }
      positions[i * 3] = _samplePoint.x;
      positions[i * 3 + 1] = _samplePoint.y;
      positions[i * 3 + 2] = _samplePoint.z;
    }
    handle.geometry.setPositions(positions);
    handle.geometry.computeBoundingSphere();
    const mat = handle.line.material as LineMaterial;
    mat.resolution.set(this.renderer.domElement.width, this.renderer.domElement.height);
  }
}
