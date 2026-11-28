/*
 * UI reference skill: vscode-ui
 * Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
 * Reference components: TreeView
 * Adaptation: Tree node, row, action, decoration, and context-menu anchor types.
 */

export interface TreeAction {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
}

export interface TreeDecoration {
  badge?: string;
  /** A CSS color value, such as `var(--modified)`. */
  color?: string;
  tooltip?: string;
  strikethrough?: boolean;
}

export interface TreeNode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  actions?: readonly TreeAction[];
  decoration?: TreeDecoration;
  children?: readonly TreeNode[];
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  parent?: string;
  ancestors: string[];
  position: number;
  setSize: number;
}

export type ContextMenuAnchor = MouseEvent | HTMLElement | null | undefined;
