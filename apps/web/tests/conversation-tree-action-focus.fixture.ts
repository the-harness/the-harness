import { TreeView, type TreeAction } from "@harness/ui-tree-view";
import { createApp, h } from "vue";

const actions: readonly TreeAction[] = [
  { id: "rename", label: "Rename conversation", icon: "i-codicon-edit" },
  { id: "delete", label: "Delete conversation", icon: "i-codicon-trash" },
];

createApp({
  render: () =>
    h(TreeView, {
      ariaLabel: "Conversations",
      nodes: [
        { id: "first", label: "First conversation", actions },
        { id: "second", label: "Second conversation", actions },
      ],
    }),
}).mount("#app");
