```ts
interface TreeAction {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
}

interface TreeDecoration {
  badge?: string;
  color?: string;
  tooltip?: string;
  strikethrough?: boolean;
}

interface TreeNode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  actions?: readonly TreeAction[];
  decoration?: TreeDecoration;
  children?: readonly TreeNode[];
}

const TreeView: Component<{
  nodes: readonly TreeNode[];
  ariaLabel?: string;
  height?: number;
  multiple?: boolean;
  expandOnLabel?: boolean;
  expandedIds?: string[];
  selectedIds?: string[];
}>;

// Optional row slots for replacing the default label or actions.
type TreeViewSlots = {
  label?: (props: { node: TreeNode }) => unknown;
  actions?: (props: { node: TreeNode }) => unknown;
};

// Public method on a mounted TreeView. An ID also reveals and focuses its row.
function focus(id?: string): void;
```
