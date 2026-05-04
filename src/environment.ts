import {
  CylinderGeometry,
  DomeGradient,
  DoubleSide,
  IBLGradient,
  Mesh,
  MeshStandardMaterial,
  PhysicsBody,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  World,
} from "@iwsdk/core";

const FLOOR_RADIUS = 4.5;
const FLOOR_HEIGHT = 0.2;
const DAIS_RADIUS = 1.6;
const DAIS_HEIGHT = 0.15;
const WALL_RADIUS = 4.6;
const WALL_HEIGHT = 3.0;

export function buildAtrium(world: World) {
  const root = world.activeLevel.value;

  // Twilight gradient — cold, dark, no pink.
  root.addComponent(DomeGradient, {
    sky: [0.078, 0.102, 0.149, 1.0],
    equator: [0.173, 0.227, 0.31, 1.0],
    ground: [0.239, 0.278, 0.329, 1.0],
    intensity: 1.0,
  });
  // IBL is decoupled from the dome — brighter than the visible sky so props
  // read clearly, but tuned down so the floor doesn't go near-white.
  root.addComponent(IBLGradient, {
    sky: [0.45, 0.5, 0.62, 1.0],
    equator: [0.5, 0.52, 0.58, 1.0],
    ground: [0.42, 0.42, 0.42, 1.0],
    intensity: 1.5,
  });

  // Floor — cylinder mesh, Box collider centered at the mesh origin.
  const floorMesh = new Mesh(
    new CylinderGeometry(FLOOR_RADIUS, FLOOR_RADIUS, FLOOR_HEIGHT, 72),
    new MeshStandardMaterial({
      color: 0x6f7378,
      roughness: 0.85,
      metalness: 0.0,
    }),
  );
  floorMesh.name = "AtriumFloor";
  floorMesh.position.set(0, -FLOOR_HEIGHT / 2, 0);
  world
    .createTransformEntity(floorMesh, root)
    .addComponent(PhysicsBody, { state: PhysicsState.Static })
    .addComponent(PhysicsShape, {
      shape: PhysicsShapeType.Box,
      dimensions: [FLOOR_RADIUS * 2, FLOOR_HEIGHT, FLOOR_RADIUS * 2],
    });

  // Dais — slightly raised inner circle. Box collider, mesh centered.
  const daisMesh = new Mesh(
    new CylinderGeometry(DAIS_RADIUS, DAIS_RADIUS, DAIS_HEIGHT, 64),
    new MeshStandardMaterial({
      color: 0x808890,
      roughness: 0.8,
      metalness: 0.0,
    }),
  );
  daisMesh.name = "AtriumDais";
  daisMesh.position.set(0, DAIS_HEIGHT / 2, 0);
  world
    .createTransformEntity(daisMesh, root)
    .addComponent(PhysicsBody, { state: PhysicsState.Static })
    .addComponent(PhysicsShape, {
      shape: PhysicsShapeType.Box,
      dimensions: [DAIS_RADIUS * 2, DAIS_HEIGHT, DAIS_RADIUS * 2],
    });

  // Curved back wall — partial cylinder, TriMesh collider matches geometry.
  const wallMesh = new Mesh(
    new CylinderGeometry(
      WALL_RADIUS,
      WALL_RADIUS,
      WALL_HEIGHT,
      96,
      1,
      true,
      Math.PI * 0.25,
      Math.PI * 1.5,
    ),
    new MeshStandardMaterial({
      color: 0x2a323d,
      roughness: 0.95,
      metalness: 0.0,
      side: DoubleSide,
    }),
  );
  wallMesh.name = "AtriumWall";
  wallMesh.position.set(0, WALL_HEIGHT / 2, 0);
  world
    .createTransformEntity(wallMesh, root)
    .addComponent(PhysicsBody, { state: PhysicsState.Static })
    .addComponent(PhysicsShape, { shape: PhysicsShapeType.TriMesh });
}
