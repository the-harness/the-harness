import { createRootScope } from "@harness/di";
import { ActionMenu, SelectBox } from "@harness/ui-components-base";
import { CommandPalette } from "@harness/ui-commands";
import { provideScope } from "@harness/ui-di";
import { NotificationCenter, UiNotificationService } from "@harness/ui-notifications";
import { QuickInputModal, UiQuickInputService } from "@harness/ui-quick-input";
import { createApp, h, nextTick, ref } from "vue";
import "../src/style.css";

const scope = createRootScope();
scope.provideAll([UiNotificationService, UiQuickInputService]);
const notifications = scope.get(UiNotificationService);
const quickInput = scope.get(UiQuickInputService);
const palette = ref(false);
const calls = ref(0);
const choice = ref("one");
const details = ref<HTMLInputElement>();

function confirm(message = "Confirm operation") {
  return notifications.showMessage({
    message,
    severity: "info",
    modal: true,
    actions: ["Continue"],
  });
}

const commands = [
  {
    id: "noop",
    title: "Record operation",
    icon: "",
    run: () => {
      calls.value++;
    },
  },
  {
    id: "details",
    title: "Focus details",
    icon: "",
    run: () => {
      details.value?.focus();
    },
  },
  {
    id: "confirm",
    title: "Confirm operation",
    icon: "",
    run: () => {
      void confirm();
    },
  },
  {
    id: "quick",
    title: "Open quick input",
    icon: "",
    run: () => {
      void quickInput.showInputBox({ title: "Enter value" });
    },
  },
];

createApp({
  setup() {
    provideScope(scope);
    return () =>
      h("main", { style: "padding: 20px" }, [
        h(
          "button",
          {
            onClick: () => {
              palette.value = true;
            },
          },
          "Open palette",
        ),
        h(
          "button",
          {
            onClick: () => {
              void confirm();
            },
          },
          "Open confirmation",
        ),
        h(
          "button",
          {
            onClick: () => {
              void confirm("First confirmation");
              void confirm("Second confirmation");
            },
          },
          "Open queued confirmations",
        ),
        h(
          "button",
          {
            onClick: () => {
              void notifications.showMessage({
                message: "Save changes?",
                severity: "warning",
                modal: true,
                actions: ["Save", "Keep editing", "Discard"],
                cancelAction: 1,
              });
            },
          },
          "Open choice confirmation",
        ),
        h(
          ActionMenu,
          {
            label: "Focus actions",
            items: [
              {
                id: "details",
                label: "Focus details later",
                run: () => {
                  void nextTick(() => details.value?.focus());
                },
              },
              {
                id: "confirm",
                label: "Confirm from menu",
                run: () => {
                  void confirm();
                },
              },
            ],
          },
          () => "Actions",
        ),
        h(SelectBox, {
          ariaLabel: "Choice",
          modelValue: choice.value,
          "onUpdate:modelValue": (value: string) => {
            choice.value = value;
          },
          options: [
            { label: "One", value: "one" },
            { label: "Two", value: "two" },
          ],
        }),
        h("input", {
          ref: details,
          "aria-label": "Details",
          style: "display: block; margin-top: 16px",
        }),
        h("output", { "aria-label": "Calls" }, String(calls.value)),
        h(CommandPalette, {
          modelValue: palette.value,
          "onUpdate:modelValue": (value: boolean) => {
            palette.value = value;
          },
          commands,
        }),
        h(NotificationCenter),
        h(QuickInputModal),
      ]);
  },
}).mount("#app");
