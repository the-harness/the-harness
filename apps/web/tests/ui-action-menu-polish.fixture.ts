import { createApp, h, ref } from "vue";
import { ActionMenu, Button, IconButton, Menu, MenuAction } from "@harness/ui-components-base";
import { DialogRoot, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogClose } from "reka-ui";
import "../src/style.css";
import "virtual:uno.css";

const selected = ref("Standard");
const status = ref("");
const longName = "DocumentationAndReleaseReviewModel".repeat(5);

createApp({
  setup: () => () =>
    h("main", { style: "padding: 16px" }, [
      h(
        ActionMenu,
        {
          label: "Model actions",
          groups: new Menu({ models: () => [
            new MenuAction({
              id: "standard",
              type: "radio",
              label: "Standard",
              checked: selected.value === "Standard",
              run: () => {
                selected.value = "Standard";
              },
            }),
            new MenuAction({
              id: "unavailable",
              label: "Unavailable",
              disabled: true,
              run: () => {
                status.value = "Unavailable ran";
              },
            }),
            new MenuAction({
              id: "review",
              type: "radio",
              label: "Review",
              checked: selected.value === "Review",
              run: () => {
                selected.value = "Review";
              },
            }),
          ], details: () => [
            new MenuAction({
              id: "documentation",
              label: longName,
              run: () => {
                status.value = longName;
              },
            }),
            new MenuAction({
              id: "details",
              label: "Open details",
              icon: "i-codicon-info",
              run: () => document.querySelector<HTMLInputElement>("input")?.focus(),
            }),
          ] }).resolve(undefined),
        },
        () => selected.value,
      ),
      h("input", { "aria-label": "Details", style: "display: block; margin-top: 12px" }),
      h("output", { "aria-label": "Last action" }, status.value),
      h(DialogRoot, {}, () => [
        h(DialogTrigger, { asChild: true }, () => h("button", {}, "Open menu dialog")),
        h(DialogPortal, {}, () => [
          h(DialogOverlay, { class: "dialog-overlay" }),
          h(DialogContent, { class: "command-palette", "aria-describedby": undefined }, () => [
            h(DialogTitle, {}, () => "Menu dialog"),
            h(ActionMenu, {
              label: "Dialog actions",
              groups: new Menu({ actions: () => [
                new MenuAction({ id: "dialog-action", label: "Run in dialog", run: () => { status.value = "Dialog action ran"; } }),
              ] }).resolve(undefined),
            }, () => "Dialog actions"),
            h(DialogClose, {}, () => "Close dialog"),
          ]),
        ]),
      ]),
      h(Button, { variant: "primary", disabled: true }, () => "Disabled primary"),
      h(Button, { disabled: true }, () => "Disabled secondary"),
      h(IconButton, { icon: "i-codicon-add", label: "Disabled action", disabled: true }),
    ]),
}).mount("#app");
