import {
  createSystem,
  eq,
  PanelDocument,
  PanelUI,
  UIKit,
  UIKitDocument,
  VisibilityState,
} from "@iwsdk/core";

import { resetProps } from "./props.js";

export class PanelSystem extends createSystem({
  welcomePanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/welcome.json")],
  },
}) {
  init() {
    this.queries.welcomePanel.subscribe("qualify", (entity) => {
      const document = PanelDocument.data.document[
        entity.index
      ] as UIKitDocument;
      if (!document) return;

      const xrButton = document.getElementById("xr-button") as UIKit.Text;
      if (xrButton) {
        xrButton.addEventListener("click", () => {
          if (this.world.visibilityState.value === VisibilityState.NonImmersive) {
            this.world.launchXR();
          } else {
            this.world.exitXR();
          }
        });
        this.cleanupFuncs.push(
          this.world.visibilityState.subscribe((state) => {
            xrButton.setProperties({
              text:
                state === VisibilityState.NonImmersive
                  ? "Enter VR"
                  : "Exit to Browser",
            });
          }),
        );
      }

      const resetButton = document.getElementById("reset-button") as UIKit.Text;
      if (resetButton) {
        resetButton.addEventListener("click", () => {
          resetProps(this.world);
        });
      }
    });
  }
}
