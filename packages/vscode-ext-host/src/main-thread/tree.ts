import { reactive } from "vue";

export interface TreeViewState {
  readonly viewId: string;
  readonly canSelectMany?: boolean;
  selection?: string[];
  revision: number;
  focusRevision: number;
}

export function createMainThreadTree(onFocus?: (viewId: string) => void) {
  const views = reactive(new Map<string, TreeViewState>());
  let focusRevision = 0;

  const handle = (method: string, args: unknown[]): boolean => {
    if (method === "tree.register") {
      const [viewId, canSelectMany] = args as [string, boolean?];
      views.set(viewId, {
        viewId,
        revision: 0,
        focusRevision: 0,
        ...(canSelectMany ? { canSelectMany } : {}),
      });
      return true;
    }
    if (method === "tree.focus") {
      const viewId = String(args[0]);
      const view = views.get(viewId);
      if (!view) throw new Error(`Unknown tree view: ${viewId}`);
      view.focusRevision = ++focusRevision;
      onFocus?.(viewId);
      return true;
    }
    if (method === "tree.refresh") {
      const [viewId] = args as [string];
      const view = views.get(viewId);
      if (view) view.revision += 1;
      return true;
    }
    if (method === "tree.unregister") {
      const [viewId] = args as [string];
      views.delete(viewId);
      return true;
    }
    return false;
  };

  return { views, handle };
}
