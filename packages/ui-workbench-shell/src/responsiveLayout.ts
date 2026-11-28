import type { DockviewApi } from "dockview-vue";

type Group = DockviewApi["groups"][number];
type Layout = ReturnType<DockviewApi["toJSON"]>;
type Node = Layout["grid"]["root"];
type Region = "left" | "right" | "below" | undefined;
type SavedLayout = Layout & {
  responsive?: { widths: Record<string, number>; preferred?: "left" | "right"; lastEditor?: string };
};
const RESTORE_MARGIN = 32;

function children(node: Node): Node[] {
  return node.type === "branch" ? node.data as Node[] : [];
}

function groupId(node: Node): string {
  return (node.data as { id: string }).id;
}

// See #975: automatic hiding is a projection, never the user's saved visibility.
export function createResponsiveLayout(
  dock: DockviewApi,
  container: HTMLElement,
  regionOf: (id: string) => Region,
  onChange: () => void,
  onFocusHidden: (group?: Group) => void,
  saved?: SavedLayout,
) {
  const states = new Map<string, {
    group: Group;
    wanted: boolean;
    width: number;
    minimum: number;
    hidden: boolean;
    dispose: () => void;
  }>();
  const savedWidths = { ...saved?.responsive?.widths };
  let preferred = saved?.responsive?.preferred ?? "left";
  let requested: string | undefined;
  let lastEditor = saved?.responsive?.lastEditor ??
    (dock.activeGroup && !regionOf(dock.activeGroup.panels[0]?.id ?? "") ? dock.activeGroup.id : undefined);
  let applying = false;
  let queued = false;
  let disposed = false;
  let dragging = false;
  let dragWidths = new Map<string, number>();
  let exclusive = false;
  const region = (group: Group) => regionOf(group.panels[0]?.id ?? "");

  function readWidths(node: Node, horizontal: boolean) {
    if (node.type === "branch") {
      for (const child of children(node)) readWidths(child, !horizontal);
    } else if (horizontal && savedWidths[groupId(node)] === undefined && node.size) {
      savedWidths[groupId(node)] = node.size;
    }
  }
  if (saved) readWidths(saved.grid.root, saved.grid.orientation !== "HORIZONTAL");

  function schedule() {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) refresh();
    });
  }

  function syncGroups() {
    for (const group of dock.groups) {
      if (states.get(group.id)?.group === group) continue;
      const previous = states.get(group.id);
      previous?.dispose();
      const width = previous?.width ?? savedWidths[group.id] ?? group.api.width;
      const state = {
        group,
        wanted: previous?.wanted ?? group.api.isVisible,
        width: Number.isFinite(width) && width > 0 ? width : region(group) === "left" ? 250 : 290,
        minimum: group.minimumWidth,
        hidden: previous?.hidden ?? false,
        dispose: () => {},
      };
      const visibility = group.api.onDidVisibilityChange(({ isVisible }) => {
        if (applying) return;
        state.wanted = isVisible;
        if (isVisible && region(group)) {
          if (region(group) !== "below") preferred = region(group) as "left" | "right";
          requested = group.id;
        } else if (isVisible && !region(group)) {
          requested = undefined;
        }
        schedule();
      });
      state.dispose = () => visibility.dispose();
      states.set(group.id, state);
    }
    for (const [id, state] of states) {
      if (dock.groups.includes(state.group)) continue;
      state.dispose();
      states.delete(id);
    }
  }

  function refresh() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (applying || width <= 0 || height <= 0) return;
    syncGroups();
    if (dragging) return;
    if (dock.activeGroup && !region(dock.activeGroup)) lastEditor = dock.activeGroup.id;
    const layout = dock.toJSON();
    const horizontal = layout.grid.orientation === "HORIZONTAL";
    const wanted = [...states.values()].filter((state) => state.wanted);
    const editors = wanted.filter((state) => !region(state.group));
    const editor = editors.find((state) => state.group.id === lastEditor) ?? editors[0];
    const anchor = editor ?? wanted.find((state) => state.group.id === requested) ??
      wanted.find((state) => state.group === dock.activeGroup) ?? wanted[0];
    const sidebarIds = new Set<string>();
    const sidebarColumns: Node[] = [];
    const hasEditor = (node: Node): boolean => {
      if (node.type === "branch") return children(node).some(hasEditor);
      const state = states.get(groupId(node));
      return Boolean(state?.wanted && (!region(state.group) || (!editors.length && state === anchor)));
    };
    function findSidebars(node: Node, axis: boolean) {
      const nested = children(node);
      if (axis && nested.some(hasEditor)) {
        const collect = (child: Node) => {
          if (child.type === "branch") children(child).forEach(collect);
          else if (region(states.get(groupId(child))!.group)) sidebarIds.add(groupId(child));
        };
        for (const child of nested.filter((child) => !hasEditor(child))) {
          sidebarColumns.push(child);
          collect(child);
        }
      }
      nested.forEach((child) => findSidebars(child, !axis));
    }
    findSidebars(layout.grid.root, horizontal);
    const candidates = wanted.filter((state) => sidebarIds.has(state.group.id)).sort((a, b) =>
      Number(region(b.group) === preferred) - Number(region(a.group) === preferred),
    );
    const minimum = (id: string) => {
      const state = states.get(id)!;
      return Math.min(width, Math.max(state.minimum, region(state.group) ? 0 : 300));
    };
    function required(node: Node, axis: boolean, visible: Set<string>, widths?: Map<string, number>): number {
      if (node.type === "leaf") {
        const id = groupId(node);
        return visible.has(id) ? widths?.get(id) ?? minimum(id) : 0;
      }
      const sizes = children(node).map((child) => required(child, !axis, visible, widths));
      return axis ? sizes.reduce((sum, size) => sum + size, 0) : Math.max(0, ...sizes);
    }
    const cost = (visible: Set<string>, widths?: Map<string, number>) =>
      required(layout.grid.root, horizontal, visible, widths);
    const visible = new Set(wanted.filter((state) => !state.hidden).map((state) => state.group.id));
    // Vertically docked views do not consume an extra column.
    for (const state of wanted) {
      if (!sidebarIds.has(state.group.id) && region(state.group)) visible.add(state.group.id);
    }
    if (anchor) visible.add(anchor.group.id);
    if (requested && states.get(requested)?.wanted) visible.add(requested);
    const removable = [
      ...candidates.toReversed(),
      ...editors.filter((state) => state !== editor),
    ];
    for (const state of removable) {
      if (cost(visible) <= width) break;
      if (state.group.id !== requested) visible.delete(state.group.id);
    }
    exclusive = Boolean(requested && visible.has(requested) && cost(visible) > width);
    if (exclusive) {
      visible.clear();
      visible.add(requested!);
    } else {
      for (const state of [...editors, ...candidates]) {
        if (visible.has(state.group.id)) continue;
        visible.add(state.group.id);
        if (cost(visible) + RESTORE_MARGIN > width) visible.delete(state.group.id);
      }
    }
    const widths = new Map(candidates.filter((state) => visible.has(state.group.id))
      .map((state) => [state.group.id, minimum(state.group.id)]));
    if (!exclusive) {
      for (const state of candidates) {
        if (!visible.has(state.group.id)) continue;
        const id = state.group.id;
        widths.set(id, Math.max(minimum(id), Math.min(state.width, minimum(id) + width - cost(visible, widths))));
      }
    }
    function shareColumnWidth(node: Node, axis: boolean, size: number) {
      if (node.type === "leaf") {
        if (visible.has(groupId(node))) widths.set(groupId(node), size);
        return;
      }
      const nested = children(node).filter((child) => required(child, !axis, visible, widths) > 0);
      let remaining = size;
      nested.forEach((child, index) => {
        const childWidth = !axis ? size : index === nested.length - 1
          ? remaining : required(child, !axis, visible, widths);
        shareColumnWidth(child, !axis, childWidth);
        remaining -= childWidth;
      });
    }
    for (const column of sidebarColumns) {
      shareColumnWidth(column, false, required(column, false, visible, widths));
    }
    const focused = [...states.values()].find((state) =>
      state.group.api.isVisible && !visible.has(state.group.id) && state.group.element.contains(document.activeElement),
    );
    applying = true;
    try {
      for (const state of states.values()) {
        state.hidden = state.wanted && !visible.has(state.group.id);
        const target = visible.has(state.group.id);
        if (state.group.api.isVisible !== target) state.group.api.setVisible(target);
        const limit = Math.min(state.minimum, width);
        if (state.group.minimumWidth !== limit) state.group.api.setConstraints({ minimumWidth: limit });
      }
      if (dock.width !== width || dock.height !== height) dock.layout(width, height);
      if (!exclusive) for (const [id, size] of widths) {
        const group = states.get(id)!.group;
        if (Math.abs(group.api.width - size) > 1) group.api.setSize({ width: size });
      }
      if (exclusive && requested && dock.activeGroup?.id !== requested) {
        states.get(requested)?.group.activePanel?.api.setActive();
      }
      if (!exclusive) requested = undefined;
      onChange();
      if (focused) onFocusHidden(exclusive ? states.get(requested!)?.group : undefined);
    } finally {
      applying = false;
    }
  }

  function serialize(): SavedLayout {
    const layout: SavedLayout = dock.toJSON();
    function restoreIntent(node: Node): boolean {
      if (node.type === "branch") {
        node.visible = children(node).map(restoreIntent).some(Boolean);
      } else {
        const state = states.get(groupId(node));
        node.visible = state?.wanted ?? node.visible !== false;
        if (state) (node.data as { minimumWidth?: number }).minimumWidth = state.minimum;
      }
      return node.visible;
    }
    restoreIntent(layout.grid.root);
    layout.responsive = {
      widths: Object.fromEntries([...states].filter(([, state]) => region(state.group))
        .map(([id, state]) => [id, state.width])),
      preferred,
      lastEditor,
    };
    return layout;
  }

  syncGroups();
  const subscriptions = [
    dock.onDidLayoutChange(schedule),
    dock.onDidActivePanelChange(({ panel }) => {
      if (applying || !panel) return;
      const area = regionOf(panel.id);
      if (!area) {
        lastEditor = panel.group.id;
        requested = undefined;
      } else if (!states.has(panel.group.id)) {
        if (area !== "below") preferred = area;
        requested = panel.group.id;
      }
      schedule();
    }),
  ];
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  const pointerDown = (event: PointerEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest(".dv-sash")) return;
    dragging = true;
    dragWidths = new Map([...states].map(([id, state]) => [id, state.group.api.width]));
  };
  const pointerUp = () => {
    if (!dragging) return;
    dragging = false;
    for (const [id, state] of states) {
      if (state.group.api.isVisible && Math.abs(state.group.api.width - (dragWidths.get(id) ?? 0)) > 1) {
        state.width = state.group.api.width;
      }
    }
    schedule();
  };
  container.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointerup", pointerUp);
  window.addEventListener("pointercancel", pointerUp);
  window.addEventListener("blur", pointerUp);
  refresh();
  return {
    refresh,
    serialize,
    dismiss() {
      if (!exclusive) return false;
      requested = undefined;
      refresh();
      onFocusHidden();
      return true;
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      subscriptions.forEach((subscription) => subscription.dispose());
      states.forEach((state) => state.dispose());
      container.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("blur", pointerUp);
    },
  };
}
