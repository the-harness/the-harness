import { EventEmitter } from "./lifecycle.ts";
import { Uri, type UriComponents } from "./uri.ts";
import {
  TabInputText,
  TabInputTextDiff,
  TabInputNotebook,
  TabInputNotebookDiff,
  TabInputCustom,
  TabInputWebview,
  TabInputTerminal,
} from "./tab-inputs.ts";

export type TabInputSnapshot =
  | { kind: "text"; uri: UriComponents }
  | { kind: "textDiff"; original: UriComponents; modified: UriComponents }
  | { kind: "notebook"; uri: UriComponents; notebookType: string }
  | { kind: "notebookDiff"; original: UriComponents; modified: UriComponents; notebookType: string }
  | { kind: "custom"; uri: UriComponents; viewType: string }
  | { kind: "webview"; viewType: string }
  | { kind: "terminal" }
  | { kind: "unknown" };

export interface TabSnapshot {
  id: string;
  label: string;
  input: TabInputSnapshot;
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
  isPreview: boolean;
}
export interface TabGroupSnapshot {
  id: string;
  viewColumn: number;
  isActive: boolean;
  tabs: readonly TabSnapshot[];
}
export interface TabGroupsSnapshot {
  groups: readonly TabGroupSnapshot[];
}
export interface WindowState {
  readonly focused: boolean;
  readonly active: boolean;
}
export interface Tab {
  readonly label: string;
  readonly group: TabGroup;
  readonly input: unknown;
  readonly isActive: boolean;
  readonly isDirty: boolean;
  readonly isPinned: boolean;
  readonly isPreview: boolean;
}
export interface TabGroup {
  readonly isActive: boolean;
  readonly viewColumn: number;
  readonly activeTab: Tab | undefined;
  readonly tabs: readonly Tab[];
}
export interface TabChangeEvent {
  readonly opened: readonly Tab[];
  readonly closed: readonly Tab[];
  readonly changed: readonly Tab[];
}
export interface TabGroupChangeEvent {
  readonly opened: readonly TabGroup[];
  readonly closed: readonly TabGroup[];
  readonly changed: readonly TabGroup[];
}

type GroupEntry = { snapshot: TabGroupSnapshot; tabs: readonly Tab[]; value: TabGroup };
type TabEntry = { snapshot: TabSnapshot; group: TabGroup; input: unknown; value: Tab };
function reviveInput(input: TabInputSnapshot): unknown {
  switch (input.kind) {
    case "text":
      return new TabInputText(Uri.from(input.uri));
    case "textDiff":
      return new TabInputTextDiff(Uri.from(input.original), Uri.from(input.modified));
    case "notebook":
      return new TabInputNotebook(Uri.from(input.uri), input.notebookType);
    case "notebookDiff":
      return new TabInputNotebookDiff(
        Uri.from(input.original),
        Uri.from(input.modified),
        input.notebookType,
      );
    case "custom":
      return new TabInputCustom(Uri.from(input.uri), input.viewType);
    case "webview":
      return new TabInputWebview(input.viewType);
    case "terminal":
      return new TabInputTerminal();
    case "unknown":
      return undefined;
  }
}

export class TabGroupsData {
  private readonly groups = new Map<string, GroupEntry>();
  private readonly tabs = new Map<string, TabEntry>();
  private readonly tabEvents = new EventEmitter<TabChangeEvent>();
  private readonly groupEvents = new EventEmitter<TabGroupChangeEvent>();
  private readonly closeItems: (
    kind: "tabs" | "groups",
    ids: string[],
    preserveFocus: boolean,
  ) => Promise<boolean>;
  private orderedGroups: readonly TabGroup[] = Object.freeze([]);
  readonly onDidChangeTabs = this.tabEvents.event;
  readonly onDidChangeTabGroups = this.groupEvents.event;

  constructor(
    close: (kind: "tabs" | "groups", ids: string[], preserveFocus: boolean) => Promise<boolean>,
  ) {
    this.closeItems = close;
  }
  get all(): readonly TabGroup[] {
    return this.orderedGroups;
  }
  get activeTabGroup(): TabGroup {
    const active = this.all.find((group) => group.isActive);
    if (!active) throw new Error("No active tab group is available");
    return active;
  }

  update(snapshot: TabGroupsSnapshot): void {
    const openedGroups: TabGroup[] = [],
      changedGroups: TabGroup[] = [];
    const opened: Tab[] = [],
      changed: Tab[] = [];
    const nextGroups = new Set<string>(),
      nextTabs = new Set<string>();
    for (const groupSnapshot of snapshot.groups) {
      nextGroups.add(groupSnapshot.id);
      let group = this.groups.get(groupSnapshot.id);
      if (!group) {
        const entry: GroupEntry = { snapshot: groupSnapshot, tabs: [], value: undefined! };
        entry.value = Object.freeze({
          get isActive() {
            return entry.snapshot.isActive;
          },
          get viewColumn() {
            return entry.snapshot.viewColumn;
          },
          get tabs() {
            return entry.tabs;
          },
          get activeTab() {
            return entry.tabs.find((tab) => tab.isActive);
          },
        });
        group = entry;
        this.groups.set(groupSnapshot.id, group);
        openedGroups.push(group.value);
      } else if (
        group.snapshot.isActive !== groupSnapshot.isActive ||
        group.snapshot.viewColumn !== groupSnapshot.viewColumn
      )
        changedGroups.push(group.value);
      group.snapshot = groupSnapshot;
      const groupTabs: Tab[] = [];
      for (const tabSnapshot of groupSnapshot.tabs) {
        nextTabs.add(tabSnapshot.id);
        let tab = this.tabs.get(tabSnapshot.id);
        if (!tab) {
          const entry: TabEntry = {
            snapshot: tabSnapshot,
            group: group.value,
            input: reviveInput(tabSnapshot.input),
            value: undefined!,
          };
          entry.value = Object.freeze({
            get label() {
              return entry.snapshot.label;
            },
            get group() {
              return entry.group;
            },
            get input() {
              return entry.input;
            },
            get isActive() {
              return entry.snapshot.isActive;
            },
            get isDirty() {
              return entry.snapshot.isDirty;
            },
            get isPinned() {
              return entry.snapshot.isPinned;
            },
            get isPreview() {
              return entry.snapshot.isPreview;
            },
          });
          tab = entry;
          this.tabs.set(tabSnapshot.id, tab);
          opened.push(tab.value);
        } else {
          const inputChanged =
            JSON.stringify(tab.snapshot.input) !== JSON.stringify(tabSnapshot.input);
          if (
            tab.group !== group.value ||
            group.tabs.indexOf(tab.value) !== groupTabs.length ||
            JSON.stringify(tab.snapshot) !== JSON.stringify(tabSnapshot)
          )
            changed.push(tab.value);
          if (inputChanged) tab.input = reviveInput(tabSnapshot.input);
          tab.snapshot = tabSnapshot;
          tab.group = group.value;
        }
        groupTabs.push(tab.value);
      }
      group.tabs = Object.freeze(groupTabs);
    }
    const closed = [...this.tabs]
      .filter(([id]) => !nextTabs.has(id))
      .map(([id, tab]) => {
        this.tabs.delete(id);
        return tab.value;
      });
    const closedGroups = [...this.groups]
      .filter(([id]) => !nextGroups.has(id))
      .map(([id, group]) => {
        this.groups.delete(id);
        return group.value;
      });
    this.orderedGroups = Object.freeze(
      snapshot.groups.map((group) => this.groups.get(group.id)!.value),
    );
    if (openedGroups.length || changedGroups.length || closedGroups.length)
      this.groupEvents.fire(
        Object.freeze({
          opened: Object.freeze(openedGroups),
          changed: Object.freeze(changedGroups),
          closed: Object.freeze(closedGroups),
        }),
      );
    if (opened.length || changed.length || closed.length)
      this.tabEvents.fire(
        Object.freeze({
          opened: Object.freeze(opened),
          changed: Object.freeze(changed),
          closed: Object.freeze(closed),
        }),
      );
  }

  async close(
    items: Tab | TabGroup | readonly Tab[] | readonly TabGroup[],
    preserveFocus = false,
  ): Promise<boolean> {
    const values = Array.isArray(items) ? items : [items];
    if (!values.length) return true;
    const groupIds: string[] = [],
      tabIds: string[] = [];
    for (const item of values) {
      const group = [...this.groups].find(([, entry]) => entry.value === item);
      const tab = [...this.tabs].find(([, entry]) => entry.value === item);
      if (group) groupIds.push(group[0]);
      else if (tab) tabIds.push(tab[0]);
      else throw new Error("Tab or tab group is no longer valid");
    }
    if (groupIds.length && tabIds.length) throw new Error("Cannot mix tabs and tab groups");
    return this.closeItems(
      groupIds.length ? "groups" : "tabs",
      groupIds.length ? groupIds : tabIds,
      preserveFocus,
    );
  }

  dispose(): void {
    this.tabEvents.dispose();
    this.groupEvents.dispose();
    this.tabs.clear();
    this.groups.clear();
    this.orderedGroups = Object.freeze([]);
  }
}
