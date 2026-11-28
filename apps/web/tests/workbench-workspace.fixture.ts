import type { Scope } from "@harness/di";
import { scopeKey } from "@harness/ui-di";
import { FileEditorService } from "@harness/ui-editor";
import { UiSessionsService } from "@harness/ui-sessions";
import { UiWorkspaceService } from "@harness/ui-workspace";

function workbenchScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

export function createFileWorkspace(root: string) {
  const workspaces = workbenchScope().get(UiWorkspaceService);
  const previousWorkspaceId = workspaces.activeWorkspaceId.value;
  const workspace = workspaces.createWorkspace({ folders: [root] });
  return { workspaceId: workspace.id, previousWorkspaceId };
}

export function removeFileWorkspace(created: ReturnType<typeof createFileWorkspace>): void {
  const workspaces = workbenchScope().get(UiWorkspaceService);
  workspaces.activeWorkspaceId.value = created.previousWorkspaceId;
  workspaces.removeWorkspace(created.workspaceId);
}

export function reloadFile(path: string): void {
  void workbenchScope().get(FileEditorService).reloadDocument(path);
}

export function createWorkspaces([frontendRoot, releaseRoot]: readonly [string, string]) {
  const scope = workbenchScope();
  const workspaces = scope.get(UiWorkspaceService);
  const sessions = scope.get(UiSessionsService);
  const previousWorkspaceId = workspaces.activeWorkspaceId.value;
  const frontend = workspaces.createWorkspace({
    name: "Frontend fixture",
    folders: [frontendRoot],
  });
  const release = workspaces.createWorkspace({ name: "Release fixture", folders: [releaseRoot] });
  const session = sessions.newSession(frontend.id);
  sessions.renameSession(session, "Frontend discussion");
  workspaces.activeWorkspaceId.value = frontend.id;
  return { frontend: frontend.id, release: release.id, session, previousWorkspaceId };
}

export function removeWorkspaces(ids: ReturnType<typeof createWorkspaces>): void {
  const scope = workbenchScope();
  const workspaces = scope.get(UiWorkspaceService);
  workspaces.activeWorkspaceId.value = ids.previousWorkspaceId;
  scope.get(UiSessionsService).removeSession(ids.session);
  workspaces.removeWorkspace(ids.frontend);
  workspaces.removeWorkspace(ids.release);
}
