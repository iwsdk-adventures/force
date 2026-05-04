import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  PhysicsBody,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  SphereGeometry,
  World,
} from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";

import {
  ForceEligible,
  SHAPE_BOX,
  SHAPE_CONE,
  SHAPE_CYLINDER,
  SHAPE_SPHERE,
} from "./components.js";

type PropSpec =
  | {
      kind: "sphere";
      radius: number;
      pos: [number, number, number];
      color: number;
      density: number;
      gravityFactor?: number;
    }
  | {
      kind: "box";
      size: [number, number, number];
      pos: [number, number, number];
      color: number;
      density: number;
      gravityFactor?: number;
    }
  | {
      kind: "cylinder";
      radius: number;
      height: number;
      pos: [number, number, number];
      color: number;
      density: number;
      gravityFactor?: number;
    }
  | {
      kind: "cone";
      radius: number;
      height: number;
      pos: [number, number, number];
      color: number;
      density: number;
      gravityFactor?: number;
    };

const TERRACOTTA = 0xb56b4d;
const MUSTARD = 0xc09b4a;
const SAGE = 0x839d6e;
const DUSTY_TEAL = 0x4f8588;
const PLUM = 0x6e3e5c;
const DUSTY_ROSE = 0xb87575;
const CREAM = 0xc8b58c;
const SLATE_BLUE = 0x6a7a98;

const PROPS: PropSpec[] = [
  // 8 spheres
  { kind: "sphere", radius: 0.32, pos: [-1.4, 0.32, -1.6], color: TERRACOTTA, density: 30 },
  { kind: "sphere", radius: 0.18, pos: [1.5, 0.18, -1.0], color: DUSTY_TEAL, density: 80 },
  { kind: "sphere", radius: 0.12, pos: [0.6, 0.12, -2.4], color: SLATE_BLUE, density: 138 },
  { kind: "sphere", radius: 0.07, pos: [-0.7, 0.22, -1.4], color: CREAM, density: 870 },
  { kind: "sphere", radius: 0.4, pos: [2.7, 0.4, -2.6], color: PLUM, density: 16 },
  { kind: "sphere", radius: 0.05, pos: [0.9, 0.2, -1.2], color: MUSTARD, density: 2400 },
  { kind: "sphere", radius: 0.22, pos: [-2.6, 0.22, -2.7], color: SAGE, density: 45 },
  { kind: "sphere", radius: 0.15, pos: [1.3, 0.15, -3.0], color: DUSTY_ROSE, density: 71 },

  // 6 boxes
  { kind: "box", size: [0.4, 0.4, 0.4], pos: [-1.9, 0.2, -2.2], color: MUSTARD, density: 23 },
  { kind: "box", size: [0.22, 0.22, 0.22], pos: [1.9, 0.11, -2.0], color: PLUM, density: 95 },
  { kind: "box", size: [0.1, 0.1, 0.1], pos: [-0.4, 0.05, -2.6], color: SAGE, density: 1000 },
  { kind: "box", size: [0.5, 0.18, 0.18], pos: [-2.4, 0.09, -1.5], color: TERRACOTTA, density: 60 },
  { kind: "box", size: [0.16, 0.16, 0.16], pos: [2.0, 0.08, -3.1], color: SLATE_BLUE, density: 244 },
  { kind: "box", size: [0.08, 0.08, 0.08], pos: [-1.1, 0.19, -1.0], color: CREAM, density: 1900 },

  // 4 cylinders
  { kind: "cylinder", radius: 0.18, height: 0.55, pos: [2.4, 0.275, -1.4], color: DUSTY_ROSE, density: 35 },
  { kind: "cylinder", radius: 0.1, height: 0.2, pos: [0.4, 0.25, -0.9], color: SAGE, density: 160 },
  { kind: "cylinder", radius: 0.14, height: 0.4, pos: [-2.7, 0.2, -0.6], color: DUSTY_TEAL, density: 65 },
  { kind: "cylinder", radius: 0.07, height: 0.18, pos: [-0.2, 0.09, -3.2], color: MUSTARD, density: 580 },

  // 6 cones
  { kind: "cone", radius: 0.25, height: 0.55, pos: [-2.3, 0.275, -1.0], color: DUSTY_TEAL, density: 35 },
  { kind: "cone", radius: 0.14, height: 0.32, pos: [1.1, 0.16, -2.6], color: MUSTARD, density: 200 },
  { kind: "cone", radius: 0.1, height: 0.3, pos: [-1.0, 0.15, -2.7], color: PLUM, density: 320 },
  { kind: "cone", radius: 0.32, height: 0.7, pos: [2.6, 0.35, -0.4], color: TERRACOTTA, density: 22 },
  { kind: "cone", radius: 0.18, height: 0.45, pos: [0.0, 0.225, -3.4], color: SAGE, density: 75 },
  { kind: "cone", radius: 0.06, height: 0.18, pos: [1.7, 0.09, -0.4], color: DUSTY_ROSE, density: 950 },

  // 4 mid-air floaters (gravityFactor 0)
  { kind: "sphere", radius: 0.13, pos: [-0.8, 1.6, -2.4], color: CREAM, density: 109, gravityFactor: 0 },
  { kind: "box", size: [0.16, 0.16, 0.16], pos: [1.0, 2.0, -2.0], color: SLATE_BLUE, density: 244, gravityFactor: 0 },
  { kind: "cone", radius: 0.12, height: 0.28, pos: [-1.7, 2.3, -1.6], color: PLUM, density: 240, gravityFactor: 0 },
  { kind: "sphere", radius: 0.09, pos: [2.0, 1.5, -1.3], color: TERRACOTTA, density: 327, gravityFactor: 0 },
];

const liveProps: Entity[] = [];

export function spawnProps(world: World) {
  const root = world.activeLevel.value;

  for (const spec of PROPS) {
    let geometry;
    let physShape: string;
    let dimensions: [number, number, number];
    let shapeKind: number;
    let dimX = 0,
      dimY = 0,
      dimZ = 0;

    if (spec.kind === "sphere") {
      geometry = new SphereGeometry(spec.radius, 32, 24);
      physShape = PhysicsShapeType.Sphere;
      dimensions = [spec.radius, 0, 0];
      shapeKind = SHAPE_SPHERE;
      dimX = spec.radius;
    } else if (spec.kind === "box") {
      geometry = new BoxGeometry(spec.size[0], spec.size[1], spec.size[2]);
      physShape = PhysicsShapeType.Box;
      dimensions = [spec.size[0], spec.size[1], spec.size[2]];
      shapeKind = SHAPE_BOX;
      dimX = spec.size[0];
      dimY = spec.size[1];
      dimZ = spec.size[2];
    } else if (spec.kind === "cylinder") {
      geometry = new CylinderGeometry(spec.radius, spec.radius, spec.height, 32);
      // Use ConvexHull — Havok's native cylinder collider has a half-height
      // origin offset that doesn't match Three.js's centered geometry.
      physShape = PhysicsShapeType.ConvexHull;
      dimensions = [spec.radius, spec.height, 0];
      shapeKind = SHAPE_CYLINDER;
      dimX = spec.radius;
      dimY = spec.height;
    } else {
      // cone — ConeGeometry extends CylinderGeometry, so Auto would mis-detect it.
      // Force ConvexHull to match the actual taper.
      geometry = new ConeGeometry(spec.radius, spec.height, 32);
      physShape = PhysicsShapeType.ConvexHull;
      dimensions = [spec.radius, spec.height, 0];
      shapeKind = SHAPE_CONE;
      dimX = spec.radius;
      dimY = spec.height;
    }

    // Per-instance material so highlight system mutates emissiveIntensity safely.
    const material = new MeshStandardMaterial({
      color: new Color(spec.color),
      roughness: 0.55,
      metalness: 0.0,
      emissive: new Color(spec.color),
      emissiveIntensity: 0.04,
    });

    const mesh = new Mesh(geometry, material);
    mesh.name = `Prop_${spec.kind}_${PROPS.indexOf(spec)}`;
    mesh.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    geometry.computeBoundingSphere();

    const entity = world
      .createTransformEntity(mesh, root)
      .addComponent(PhysicsBody, {
        state: PhysicsState.Dynamic,
        gravityFactor: spec.gravityFactor ?? 1,
        linearDamping: 0.1,
        angularDamping: 0.2,
      })
      .addComponent(PhysicsShape, {
        shape: physShape as any,
        dimensions,
        density: spec.density,
        friction: 0.5,
        restitution: 0.2,
      })
      .addComponent(ForceEligible, {
        density: spec.density,
        shapeKind,
        dimX,
        dimY,
        dimZ,
      });

    liveProps.push(entity);
  }
}

export function resetProps(world: World) {
  for (const e of liveProps) {
    e.dispose();
  }
  liveProps.length = 0;
  spawnProps(world);
}
