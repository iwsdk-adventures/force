import {
  PanelUI,
  RayInteractable,
  ScreenSpace,
  SessionMode,
  World,
} from "@iwsdk/core";

import { AnimatedControllerHand } from "./animatedControllerHand.js";
import { BoidSystem } from "./boids.js";
import { buildAtrium } from "./environment.js";
import { ForceGrabSystem } from "./forceGrab.js";
import { ForceLiftSystem } from "./forceLift.js";
import { ForceRaySystem } from "./forceRay.js";
import { ForceTargetingSystem } from "./forceTargeting.js";
import { HighlightSystem } from "./highlight.js";
import { PanelSystem } from "./panel.js";
import { spawnProps } from "./props.js";

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "always",
    features: { handTracking: true, layers: true },
  },
  features: {
    locomotion: false,
    grabbing: true,
    physics: true,
    sceneUnderstanding: false,
    environmentRaycast: false,
  },
}).then((world) => {
  world.camera.position.set(0, 1.6, 0);

  // Animated hand visual in place of the default controller. Uses our local
  // vendored copy of IWSDK's AnimatedControllerHand to work around the
  // upstream constructor parameter-order bug (see animatedControllerHand.ts).
  world.input.visualAdapters.controller.left.updateVisualImplementation(
    AnimatedControllerHand,
  );
  world.input.visualAdapters.controller.right.updateVisualImplementation(
    AnimatedControllerHand,
  );

  buildAtrium(world);
  spawnProps(world);

  const panelEntity = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "./ui/welcome.json",
      maxHeight: 0.9,
      maxWidth: 1.6,
    })
    .addComponent(RayInteractable)
    .addComponent(ScreenSpace, {
      top: "20px",
      left: "20px",
      height: "45%",
    });
  panelEntity.object3D!.position.set(0, 1.45, -2.0);

  world
    .registerSystem(ForceTargetingSystem, { priority: -3 })
    .registerSystem(ForceGrabSystem, { priority: -2.5 })
    .registerSystem(ForceLiftSystem, { priority: -2.5 })
    .registerSystem(HighlightSystem)
    .registerSystem(ForceRaySystem)
    .registerSystem(BoidSystem)
    .registerSystem(PanelSystem);
});
