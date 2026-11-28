import { TreeView, type TreeNode } from "@harness/ui-tree-view";
import { createApp, h, ref } from "vue";
import "../src/style.css";
import "virtual:uno.css";

const nodes = ref<TreeNode[]>([
  {
    id: "workspace",
    label: "Workspace",
    children: Array.from({ length: 40 }, (_, index) => ({
      id: `conversation-${index}`,
      label: `Conversation ${index + 1}`,
      actions: [{ id: "rename", label: "Rename conversation", icon: "i-codicon-edit" }],
    })),
  },
  { id: "other", label: "Other workspace" },
]);
const expanded = ref(["workspace"]);
const selected = ref<string[]>([]);
const focused = ref<string>();

createApp({
  setup: () => () =>
    h("main", { style: "padding: 16px; width: 360px" }, [
      h("button", { type: "button" }, "Before tree"),
      h(TreeView, {
        nodes: nodes.value,
        height: 132,
        ariaLabel: "Conversations",
        expandedIds: expanded.value,
        "onUpdate:expandedIds": (value: string[]) => {
          expanded.value = value;
        },
        selectedIds: selected.value,
        "onUpdate:selectedIds": (value: string[]) => {
          selected.value = value;
        },
        onFocusChange: (value: string | undefined) => {
          focused.value = value;
        },
      }),
      h("button", { type: "button" }, "After tree"),
      h(
        "button",
        {
          type: "button",
          onClick: () => {
            expanded.value = [];
          },
        },
        "Collapse workspace",
      ),
      h(
        "button",
        {
          type: "button",
          onClick: () => {
            nodes.value = nodes.value.map((node) => ({
              ...node,
              children: node.children?.filter(({ id }) => id !== focused.value),
            }));
          },
        },
        "Remove focused conversation",
      ),
    ]),
}).mount("#app");
