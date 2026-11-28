import type { ScmGroup, ScmResource } from "@harness/ui-scm";
import { Uri, type UriComponents } from "@harness/vscode-types";
import { markRaw, reactive, watch } from "vue";

type ResourceSnapshot = Omit<ScmResource, "resourceUri"> & { resourceUri: UriComponents };

export interface ScmProviderState {
  readonly handle: string;
  readonly id: string;
  readonly label: string;
  readonly rootPath?: string;
  readonly iconPath?: unknown;
  readonly parent?: string;
  contextValue?: string;
  activeRepositoryName?: string;
  inputValue: string;
  inputPlaceholder: string;
  inputEnabled?: boolean;
  inputVisible?: boolean;
  selected?: boolean;
  count?: number;
  commitTemplate?: string;
  statusBarCommands?: { command: string; title?: string }[];
  acceptInputCommand?: { command: string; title?: string };
  readonly groups: Map<string, ScmGroup & { id: string; resources: (string | ScmResource)[] }>;
}

export function createMainThreadScm(emit?: (command: string, args: unknown[]) => void) {
  const watchers = new Map<string, () => void>();
  const providers = reactive(new Map<string, ScmProviderState>());

  const handle = (method: string, args: unknown[]): boolean => {
    if (method === "scm.create") {
      const [h, id, label, rootPath, options] = args as [
        string,
        string,
        string,
        string?,
        { iconPath?: unknown; parent?: string }?,
      ];
      watchers.get(h)?.();
      providers.set(h, {
        handle: h,
        id,
        label,
        rootPath,
        ...options,
        inputValue: "",
        inputPlaceholder: "",
        groups: reactive(new Map()),
      });
      const provider = providers.get(h)!;
      provider.selected = providers.size === 1;
      watchers.set(
        h,
        watch(
          () => [provider.inputValue, provider.selected] as const,
          ([value, selected], previous) => {
            if (!previous || value !== previous[0]) emit?.("__scm.inputChanged", [h, value]);
            if (!previous || selected !== previous[1])
              emit?.("__scm.selectionChanged", [h, selected]);
          },
          { immediate: true, flush: "sync" },
        ),
      );
      return true;
    }
    if (method === "scm.updateProvider") {
      const [h, patch] = args as [
        string,
        {
          count?: number | null;
          commitTemplate?: string | null;
          statusBarCommands?: ScmProviderState["statusBarCommands"];
          contextValue?: string | null;
          activeRepositoryName?: string | null;
        },
      ];
      const provider = providers.get(h);
      if (provider) {
        if ("count" in patch) provider.count = patch.count ?? undefined;
        if ("commitTemplate" in patch) provider.commitTemplate = patch.commitTemplate ?? undefined;
        if ("statusBarCommands" in patch) provider.statusBarCommands = patch.statusBarCommands;
        if ("contextValue" in patch) provider.contextValue = patch.contextValue ?? undefined;
        if ("activeRepositoryName" in patch)
          provider.activeRepositoryName = patch.activeRepositoryName ?? undefined;
      }
      return true;
    }
    if (method === "scm.inputBox") {
      const [h, patch] = args as [
        string,
        { value?: string; placeholder?: string; enabled?: boolean; visible?: boolean },
      ];
      const p = providers.get(h);
      if (p) {
        if (patch.value !== undefined) p.inputValue = patch.value;
        if (patch.placeholder !== undefined) p.inputPlaceholder = patch.placeholder;
        if (patch.enabled !== undefined) p.inputEnabled = patch.enabled;
        if (patch.visible !== undefined) p.inputVisible = patch.visible;
      }
      return true;
    }
    if (method === "scm.acceptInputCommand") {
      const [h, cmd] = args as [string, { command: string; title?: string } | undefined];
      const p = providers.get(h);
      if (p) p.acceptInputCommand = cmd;
      return true;
    }
    if (method === "scm.createGroup") {
      const [h, groupId, groupLabel] = args as [string, string, string];
      providers.get(h)?.groups.set(groupId, { id: groupId, label: groupLabel, resources: [] });
      return true;
    }
    if (method === "scm.updateGroup") {
      const [h, groupId, patch] = args as [
        string,
        string,
        { label?: string; hideWhenEmpty?: boolean },
      ];
      const group = providers.get(h)?.groups.get(groupId);
      if (group) Object.assign(group, patch);
      return true;
    }
    if (method === "scm.setResources") {
      const [h, groupId, resources] = args as [string, string, (string | ResourceSnapshot)[]];
      const group = providers.get(h)?.groups.get(groupId);
      if (group) {
        group.resources = resources.map((resource) =>
          typeof resource === "string"
            ? resource
            : { ...resource, resourceUri: markRaw(Uri.from(resource.resourceUri)) },
        );
      }
      return true;
    }
    if (method === "scm.disposeGroup") {
      const [h, groupId] = args as [string, string];
      providers.get(h)?.groups.delete(groupId);
      return true;
    }
    if (method === "scm.dispose") {
      const [h] = args as [string];
      watchers.get(h)?.();
      watchers.delete(h);
      providers.delete(h);
      return true;
    }
    return false;
  };

  return {
    providers,
    handle,
    dispose() {
      for (const stop of watchers.values()) stop();
      watchers.clear();
      providers.clear();
    },
  };
}
