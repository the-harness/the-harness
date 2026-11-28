import * as monaco from "monaco-editor";
import type { Scope } from "@harness/di";
import { scopeKey } from "@harness/ui-di";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { UiConfigService } from "@harness/ui-config";
import { UiTabsService } from "@harness/ui-workbench";
import { FileEditorService, openFileEditorTab } from "@harness/ui-editor";
import {
  Uri,
  Range,
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { createMainThreadWorkspace } from "../../../packages/vscode-ext-host/src/main-thread/workspace.ts";

function appScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

export async function renameFromExtensionHost(
  root: string,
  source: string,
  target: string,
  foreground: boolean,
): Promise<void> {
  const scope = appScope();
  const workspace = scope.get(UiWorkspaceService);
  const compat = scope.get(VscodeWorkspaceCompatService);
  const handle = createMainThreadWorkspace(
    {
      activeRoots: { value: [root] },
      getRoot: (path) => workspace.getRoot(path),
      renameDocument: (path, from, to) => compat.renameDocument(path, from, to),
    },
    scope.get(UiConfigService),
    foreground ? compat : undefined,
  );
  await handle("workspace.rename", [Uri.file(source).toJSON(), Uri.file(target).toJSON()]);
}

export function preview(root: string, name: string) {
  const scope = appScope();
  scope.get(UiWorkspaceService).addRoot(root);
  openFileEditorTab(scope.get(UiTabsService), scope.get(FileEditorService), {
    root,
    relativePath: name,
    preview: true,
  });
}

export async function show(
  root: string,
  name: string,
  selection?: [number, number, number, number],
  preserveFocus = false,
) {
  const scope = appScope();
  scope.get(UiWorkspaceService).addRoot(root);
  await scope.get(VscodeWindowCompatService).showTextDocument(Uri.file(`${root}/${name}`), {
    preview: false,
    preserveFocus,
    selection: selection ? new Range(...selection) : undefined,
  });
}

export function snapshot() {
  const scope = appScope();
  const active = scope.get(VscodeWindowCompatService).activeTextEditor.value;
  const tabs = scope.get(UiTabsService);
  const selected = tabs.groups.value.flatMap((group) => {
    const tab = group.activeTabId ? tabs.get(group.activeTabId) : undefined;
    return tab ? [tab.descriptor.defaultTitle] : [];
  });
  const target = monaco.editor
    .getEditors()
    .find((editor) => editor.getModel()?.getValue().includes("reopenedTarget"));
  const selection = target?.getSelection();
  return {
    activePath: active?.document.fileName,
    previewPath: scope.get(FileEditorService).previewPath.value,
    selected,
    target: {
      selectedText: target?.getModel()?.getValueInRange(selection!),
      visibleRanges:
        target
          ?.getVisibleRanges()
          .map((range) => ({ start: range.startLineNumber - 1, end: range.endLineNumber - 1 })) ??
        [],
      focused: target?.hasTextFocus(),
    },
  };
}
