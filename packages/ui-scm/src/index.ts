import { inject } from "@harness/di";
import { UiCommandsService } from "@harness/ui-commands";
import { FileEditorService, openFileEditorTab } from "@harness/ui-editor";
import { UiTabsService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { computed, shallowRef, watch } from "vue";
import { createScmMenu, isScmMenuTargetCurrent, type ScmMenuContext } from "./menus.ts";

export type { ScmMenuContext } from "./menus.ts";

export interface ScmResource {
  readonly resourceUri: {
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;
    toString(): string;
  };
  readonly command?: { readonly command: string; readonly tooltip?: string };
  readonly decorations?: {
    readonly tooltip?: string;
    readonly strikeThrough?: boolean;
    readonly faded?: boolean;
  };
  readonly contextValue?: string;
}

export interface ScmGroup {
  readonly label: string;
  readonly resources: readonly (string | ScmResource)[];
  readonly hideWhenEmpty?: boolean;
}

// Extensible: SCM providers (e.g. built-in git or extension-contributed) register via UiScmService.
export interface ScmProvider {
  readonly handle: number | string;
  readonly label: string;
  inputValue: string;
  readonly inputPlaceholder?: string;
  readonly acceptInputCommand?: { readonly command: string };
  readonly groups: ReadonlyMap<string, ScmGroup>;
}

export class UiScmService {
  readonly menu = createScmMenu(this, () => this.workspace.activeRoots.value);
  readonly collapsedGroups = shallowRef<ReadonlySet<string>>(new Set());
  private readonly editor = inject(FileEditorService);
  private readonly tabs = inject(UiTabsService);
  private readonly workspace = inject(UiWorkspaceService);
  private readonly commands = inject(UiCommandsService);
  private readonly sources = shallowRef<ReadonlySet<() => readonly ScmProvider[]>>(new Set());

  readonly providers = computed(() => {
    const folders = this.workspace.currentWorkspace.value?.folders;
    if (folders && this.workspace.activeRoots.value.some((root) => !folders.includes(root))) return [];
    const list: ScmProvider[] = [];
    for (const source of this.sources.value) {
      list.push(...source());
    }
    return list;
  });

  constructor() {
    watch(() => this.workspace.currentWorkspace.value?.id, () => {
      this.collapsedGroups.value = new Set();
    });
  }

  isMenuTargetCurrent(context: ScmMenuContext): boolean {
    return isScmMenuTargetCurrent(this.providers.value, context);
  }

  submitInput(provider: ScmProvider): void {
    if (provider.acceptInputCommand) void this.commands.execute(provider.acceptInputCommand.command);
  }

  toggleGroup(provider: ScmProvider, groupId: string): void {
    const key = `${provider.handle}:${groupId}`;
    const next = new Set(this.collapsedGroups.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.collapsedGroups.value = next;
  }

  registerProviderSource(source: () => readonly ScmProvider[]): () => void {
    const next = new Set(this.sources.value);
    next.add(source);
    this.sources.value = next;
    return () => {
      const updated = new Set(this.sources.value);
      updated.delete(source);
      this.sources.value = updated;
    };
  }

  async openResource(resource: string | ScmResource): Promise<void> {
    if (typeof resource !== "string" && resource.command) {
      await this.commands.execute(resource.command.command);
      return;
    }
    if (typeof resource !== "string" && resource.resourceUri.scheme !== "file") return;

    const filePath = typeof resource === "string" ? resource : resource.resourceUri.fsPath;
    const roots = this.workspace.activeRoots.value;
    let match: { root: string; relativePath: string } | undefined;
    for (const root of roots) {
      const prefix = `${root.replace(/\/+$/, "")}/`;
      if (!filePath.startsWith(prefix)) continue;
      const relativePath = filePath.slice(prefix.length);
      if (relativePath && (!match || relativePath.length < match.relativePath.length)) {
        match = { root, relativePath };
      }
    }
    if (match) await openFileEditorTab(this.tabs, this.editor, match);
  }
}

export { default as ChangesPanel } from "./ChangesPanel.vue";
