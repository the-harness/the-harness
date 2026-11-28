import * as monaco from "monaco-editor";
import { effectScope, ref } from "vue";
import { UiTabsService } from "@harness/ui-workbench";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { FileEditorService, type EditorDocument } from "@harness/ui-editor";
import {
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";

export function mountEventEditor(path = "/fixture/events.ts") {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const document: EditorDocument = {
    id: 1,
    path,
    root: path.slice(0, path.lastIndexOf("/")),
    relativePath: name,
    name,
    language: "typescript",
    content: "first\nsecond",
    savedContent: "first\nsecond",
    mtimeMs: 1,
    size: 12,
    loading: false,
    binary: false,
    tooLarge: false,
    externalDeleted: false,
    externalChanged: false,
  };
  const scope = effectScope();
  const container = window.document.createElement("div");
  container.style.cssText = "height:200px;width:500px";
  window.document.body.appendChild(container);
  const editor = monaco.editor.create(container, {
    value: document.content,
    language: "plaintext",
    occurrencesHighlight: "off",
  });
  const instance = scope.run(() =>
    runInInjectionContext(
      {
        get<T>(id: abstract new (...args: any[]) => T): T {
          if (id === FileEditorService)
            return {
              registerEditorHook: () => () => {},
              getDocument: () => document,
              isDirty: () => false,
            } as T;
          if (id === VscodeWorkspaceCompatService)
            return { getTextDocument: () => undefined } as unknown as T;
          if (id === UiTabsService) return { groups: ref([]), useRenderer() {} } as unknown as T;
          throw new Error(`Unexpected fixture dependency: ${id.name}`);
        },
      },
      () => new VscodeWindowCompatService(),
    ),
  )!;
  return {
    editor,
    instance,
    register: () => instance.registerMonacoEditor(path, editor),
    close() {
      editor.dispose();
      container.remove();
      scope.stop();
    },
  };
}

export function observeEditorEvents() {
  const { editor, instance, register, close } = mountEventEditor();
  const visible: number[] = [];
  const selections: { active: number[]; kind?: number }[] = [];
  const visibleRanges: number[] = [];
  instance.onDidChangeVisibleTextEditors((editors) => visible.push(editors.length));
  instance.onDidChangeTextEditorSelection((event) =>
    selections.push({
      active: [event.selections[0]!.active.line, event.selections[0]!.active.character],
      kind: event.kind,
    }),
  );
  instance.onDidChangeTextEditorVisibleRanges((event) =>
    visibleRanges.push(event.visibleRanges[0]?.start.line ?? -1),
  );
  try {
    const unregister = register();
    editor.setSelection(new monaco.Selection(2, 2, 2, 4));
    editor.setSelections([new monaco.Selection(1, 1, 1, 2)], "code.navigation");
    editor.setSelections([new monaco.Selection(2, 2, 2, 1)], "code.jump");
    editor.setValue(Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"));
    editor.setValue(editor.getValue() + "\nmore");
    editor.setScrollTop(800, monaco.editor.ScrollType.Immediate);
    unregister();
    return { visible, selections, visibleRanges };
  } finally {
    close();
  }
}
