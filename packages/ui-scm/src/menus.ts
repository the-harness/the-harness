import { Menu, MenuAction } from "@harness/ui-menu";
import type { ScmGroup, ScmProvider, ScmResource, UiScmService } from "./index.ts";

export type ScmMenuContext = { readonly provider: ScmProvider } & (
  | { readonly group?: undefined; readonly resource?: undefined }
  | { readonly group: ScmGroup; readonly groupId: string; readonly resource?: string | ScmResource }
);

export function createScmMenu(
  scm: Pick<UiScmService, "collapsedGroups" | "toggleGroup" | "openResource" | "submitInput">,
  getRoots: () => readonly string[],
) {
  return new Menu({
    resource: (context: ScmMenuContext) => {
      const { provider, group, resource } = context;
      if (resource !== undefined) {
        return [new MenuAction({ id: "open", label: "Open",
          disabled: typeof resource !== "string" && resource.resourceUri.scheme !== "file" && !resource.command,
          run: () => scm.openResource(resource) })];
      }
      if (group) return [
        new MenuAction({ id: "collapse", label: scm.collapsedGroups.value.has(`${provider.handle}:${context.groupId}`) ? "Expand" : "Collapse",
          run: () => scm.toggleGroup(provider, context.groupId) }),
        new MenuAction({ id: "copy-paths", label: "Copy Paths", disabled: !group.resources.length,
          run: () => navigator.clipboard.writeText(group.resources.map((resource) => typeof resource === "string" ? resource : resource.resourceUri.fsPath).join("\n")) }),
      ];
      return [new MenuAction({ id: "submit", label: "Submit Message", visible: !!provider.acceptInputCommand,
        disabled: !provider.inputValue.trim(), run: () => scm.submitInput(provider) })];
    },
    clipboard: ({ resource }: ScmMenuContext) => {
      if (resource === undefined) return [];
      const file = typeof resource === "string" || resource.resourceUri.scheme === "file";
      const path = typeof resource === "string" ? resource : resource.resourceUri.fsPath;
      const root = [...getRoots()].sort((a, b) => b.length - a.length)
        .find((root) => path.startsWith(`${root.replace(/\/+$/, "")}/`));
      return [
        new MenuAction({ id: "copy-path", label: file ? "Copy Path" : "Copy URI",
          run: () => navigator.clipboard.writeText(file ? path : resource.resourceUri.toString()) }),
        new MenuAction({ id: "copy-relative-path", label: "Copy Relative Path", visible: file && !!root,
          run: () => navigator.clipboard.writeText(path.slice(root!.replace(/\/+$/, "").length + 1)) }),
      ];
    },
    groups: ({ provider, group }: ScmMenuContext) => group ? [] : [
      new MenuAction({ id: "collapse-all", label: "Collapse All Groups", disabled: !provider.groups.size,
        run: () => setGroupsCollapsed(scm, provider, true) }),
      new MenuAction({ id: "expand-all", label: "Expand All Groups", disabled: !provider.groups.size,
        run: () => setGroupsCollapsed(scm, provider, false) }),
    ],
  });
}

export function isScmMenuTargetCurrent(providers: readonly ScmProvider[], context: ScmMenuContext): boolean {
  return providers.includes(context.provider) && (!context.group || (
    context.provider.groups.get(context.groupId) === context.group &&
    (context.resource === undefined || context.group.resources.includes(context.resource))
  ));
}

function setGroupsCollapsed(scm: Pick<UiScmService, "collapsedGroups">, provider: ScmProvider, collapsed: boolean): void {
  const next = new Set(scm.collapsedGroups.value);
  for (const id of provider.groups.keys()) {
    const key = `${provider.handle}:${id}`;
    if (collapsed) next.add(key);
    else next.delete(key);
  }
  scm.collapsedGroups.value = next;
}
