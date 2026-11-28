import type { Command, TreeItem } from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";
import { EventEmitter } from "./types.ts";

export interface TreeDataProvider<T = unknown> {
  onDidChangeTreeData?: (listener: (e?: T) => void) => { dispose(): void };
  getTreeItem(element: T): unknown | Promise<unknown>;
  getChildren(element?: T): T[] | Promise<T[] | undefined> | undefined;
}

export function createTreeApi(bridge: ExtHostBridge) {
  const registerTreeDataProvider = <T>(
    viewId: string,
    provider: TreeDataProvider<T>,
    options?: {
      canSelectMany?: boolean;
      onCheckboxChange?(items: [T, number][]): void;
      onSelectionChange?(selection: readonly T[]): void;
    },
  ) => {
    const cmd = `__tree.getChildren.${viewId}`;
    if (bridge.commandHandlers.has(cmd))
      throw new Error(`Tree data provider for ${viewId} is already registered`);
    const nodes = new Map<
      string,
      { element: T; parentId?: string; command?: Command; revision: number }
    >();
    const branches = new Map<string | undefined, readonly string[]>();
    const requests = new Map<string | undefined, symbol>();
    const viewKey = JSON.stringify([viewId, crypto.randomUUID()]);
    let revision = 0;
    let disposed = false;
    let selectionIds: string[] = [];
    const executeCommand = `__tree.execute.${viewId}`;
    const checkboxCommand = `__tree.checkbox.${viewId}`;
    const selectionCommand = `__tree.selection.${viewId}`;
    const focusCommand = `${viewId}.focus`;

    function getSelection(): readonly T[] {
      return selectionIds.flatMap((id) => {
        const node = nodes.get(id);
        return node ? [node.element] : [];
      });
    }

    function setSelection(ids: string[]): void {
      if (ids.length === selectionIds.length && ids.every((id, i) => id === selectionIds[i]))
        return;
      selectionIds = ids;
      options?.onSelectionChange?.(getSelection());
    }
    function forgetNode(id: string, parentId?: string): void {
      const node = nodes.get(id);
      if (!node || node.parentId !== parentId) return;
      nodes.delete(id);
      forgetChildren(id);
    }

    function forgetChildren(id: string): void {
      const children = branches.get(id) ?? [];
      branches.delete(id);
      requests.delete(id);
      for (const child of children) forgetNode(child, id);
    }

    bridge.commandHandlers.set(focusCommand, () => bridge.callMain("tree.focus", viewId));
    void bridge.callMain("commands.register", focusCommand);
    bridge.commandHandlers.set(executeCommand, (id) => {
      const command = nodes.get(String(id))?.command;
      if (!command) return undefined;
      const callback = bridge.commandHandlers.get(command.command);
      return callback
        ? callback(...(command.arguments ?? []))
        : bridge.callMain("commands.execute", command.command, ...(command.arguments ?? []));
    });
    void bridge.callMain("commands.register", executeCommand);
    bridge.commandHandlers.set(checkboxCommand, (rawChanges) => {
      const items: [T, number][] = [];
      for (const { id, state } of rawChanges as { id: string; state: number }[]) {
        if (state !== 0 && state !== 1) throw new TypeError("Invalid checkbox state");
        const node = nodes.get(id);
        if (node) items.push([node.element, state]);
      }
      if (items.length) options?.onCheckboxChange?.(items);
    });
    bridge.commandHandlers.set(selectionCommand, (ids) => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !nodes.has(id)))
        return false;
      setSelection(options?.canSelectMany ? [...new Set<string>(ids)] : ids.slice(0, 1));
      return true;
    });

    bridge.commandHandlers.set(cmd, async (elementId?: unknown) => {
      const parentId = typeof elementId === "string" ? elementId : undefined;
      const parent = parentId === undefined ? undefined : nodes.get(parentId);
      if (parentId !== undefined && !parent) return [];

      const request = Symbol();
      requests.set(parentId, request);
      try {
        const children = (await provider.getChildren(parent?.element)) ?? [];
        const items = await Promise.all(
          children.map(async (element) => ({
            element,
            item: (await provider.getTreeItem(element)) as TreeItem | undefined,
          })),
        );
        if (
          requests.get(parentId) !== request ||
          (parentId !== undefined && nodes.get(parentId) !== parent)
        )
          return null;

        const ancestors = new Set<string>();
        for (let id = parentId; id !== undefined; id = nodes.get(id)?.parentId) ancestors.add(id);
        const labelCounts = new Map<string, number>();
        const ids = new Set<string>();
        const entries = items.map(({ element, item }) => {
          const resourceUri = item?.resourceUri;
          const label =
            (typeof item?.label === "string" ? item.label : item?.label?.label) ||
            resourceUri?.path?.split("/").at(-1) ||
            "";
          const occurrence = (labelCounts.get(label) ?? 0) + 1;
          labelCounts.set(label, occurrence);
          const id =
            item?.id === undefined
              ? `${parentId ?? viewKey}:child:${JSON.stringify(label)}:${occurrence}`
              : `${viewKey}:id:${JSON.stringify(item.id)}`;
          const existing = nodes.get(id);
          if (
            ids.has(id) ||
            ancestors.has(id) ||
            (existing && existing.revision === revision && existing.parentId !== parentId)
          )
            throw new Error(`Duplicate tree item ID in ${viewId}: ${item?.id ?? label}`);
          ids.add(id);
          return { id, label, element, item, resourceUri };
        });
        for (const id of branches.get(parentId) ?? []) if (!ids.has(id)) forgetNode(id, parentId);
        branches.set(parentId, [...ids]);
        const result = entries.map(({ id, label, element, item, resourceUri }) => {
          const command = item?.command;
          nodes.set(id, { element, parentId, command, revision });
          if (!item?.collapsibleState) forgetChildren(id);
          return {
            id,
            label,
            resourceUri,
            description: typeof item?.description === "string" ? item.description : undefined,
            collapsibleState: item?.collapsibleState ?? 0,
            checkboxState: item?.checkboxState,
            command: command
              ? { command: executeCommand, title: command.title, arguments: [id] }
              : undefined,
          };
        });
        setSelection(selectionIds.filter((id) => nodes.has(id)));
        return result;
      } finally {
        if (requests.get(parentId) === request) requests.delete(parentId);
      }
    });

    void bridge.callMain("tree.register", viewId, ...(options?.canSelectMany ? [true] : []));
    const changeSub = provider.onDidChangeTreeData?.(() => {
      revision++;
      requests.clear();
      void bridge.callMain("tree.refresh", viewId);
    });

    return {
      get selection() {
        return getSelection();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        changeSub?.dispose();
        bridge.commandHandlers.delete(cmd);
        bridge.commandHandlers.delete(focusCommand);
        void bridge.callMain("commands.unregister", focusCommand);
        bridge.commandHandlers.delete(executeCommand);
        bridge.commandHandlers.delete(checkboxCommand);
        bridge.commandHandlers.delete(selectionCommand);
        void bridge.callMain("commands.unregister", executeCommand);
        nodes.clear();
        selectionIds = [];
        branches.clear();
        requests.clear();
        void bridge.callMain("tree.unregister", viewId);
      },
    };
  };

  const createTreeView = <T>(
    viewId: string,
    options: { treeDataProvider: TreeDataProvider<T>; canSelectMany?: boolean },
  ) => {
    const checkboxEmitter = new EventEmitter<{ readonly items: readonly [T, number][] }>();
    const selectionEmitter = new EventEmitter<{ readonly selection: readonly T[] }>();
    const visibilityEmitter = new EventEmitter<{ readonly visible: boolean }>();
    const reg = registerTreeDataProvider(viewId, options.treeDataProvider, {
      canSelectMany: options.canSelectMany,
      onCheckboxChange: (items) => checkboxEmitter.fire({ items }),
      onSelectionChange: (selection) => selectionEmitter.fire({ selection }),
    });

    return {
      get selection() {
        return reg.selection;
      },
      visible: true,
      onDidChangeSelection: selectionEmitter.event,
      onDidChangeVisibility: visibilityEmitter.event,
      onDidChangeCheckboxState: checkboxEmitter.event,
      async reveal() {},
      dispose() {
        reg.dispose();
        selectionEmitter.dispose();
        visibilityEmitter.dispose();
        checkboxEmitter.dispose();
      },
    };
  };

  return { registerTreeDataProvider, createTreeView };
}
