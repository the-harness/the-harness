import * as monaco from "monaco-editor";
import { effectScope, nextTick, ref } from "vue";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { FileEditorService } from "@harness/ui-editor";
import { UiConfigService } from "@harness/ui-config";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { UiTabsService } from "@harness/ui-workbench";
import {
  Position,
  Range,
  Uri,
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";

export async function observeWorkspaceEditorSemantics() {
  const root = "/fixture";
  const path = `${root}/document.ts`;
  const saved = new Map([["document.ts", "ab\r\ncd\r\n"]]);
  const scope = effectScope();
  const containers: HTMLElement[] = [];
  const registrations: (() => void)[] = [];
  const editors: monaco.editor.IStandaloneCodeEditor[] = [];
  const tabScopes: ReturnType<typeof effectScope>[] = [];
  let files: FileEditorService;
  let workspace: VscodeWorkspaceCompatService;
  let windowCompat: VscodeWindowCompatService;
  const workspaceSource = {
    activeRoots: ref([root]),
    onFileChange: () => () => {},
    getRoot: () => ({
      async readFile(relative: string) {
        const content = saved.get(relative);
        if (content === undefined) throw new Error(`Missing file: ${relative}`);
        return {
          content,
          encoding: "utf8",
          binary: false,
          tooLarge: false,
          mtimeMs: 1,
          size: content.length,
        };
      },
      async writeFile(relative: string, content: string) {
        saved.set(relative, content);
        return { mtimeMs: 2, size: content.length };
      },
    }),
  };
  let tabOpens = 0;
  const tabs = {
    tabs: new Map(),
    groups: ref([]),
    open(descriptor: { documentId: number }) {
      tabOpens++;
      const source = files.getDocumentById(descriptor.documentId)!;
      const container = document.createElement("div");
      container.style.cssText = "height:200px;width:500px";
      document.body.appendChild(container);
      containers.push(container);
      const editor = monaco.editor.create(container, {
        value: source.content,
        language: "plaintext",
      });
      editors.push(editor);
      editor.onDidChangeModelContent(() => files.updateContent(source.path, editor.getValue()));
      registrations.push(windowCompat.registerMonacoEditor(source.path, editor));
      const tabScope = effectScope();
      tabScopes.push(tabScope);
      return { scope: tabScope, title: "document.ts" };
    },
  };
  scope.run(() =>
    runInInjectionContext(
      {
        get<T>(id: abstract new (...args: any[]) => T): T {
          if (id === UiWorkspaceService) return workspaceSource as unknown as T;
          if (id === FileEditorService) return files as T;
          if (id === UiConfigService)
            return { get: (_key: string, fallback: unknown) => fallback } as T;
          if (id === VscodeWorkspaceCompatService) return workspace as T;
          if (id === UiTabsService) return tabs as unknown as T;
          throw new Error(`Unexpected fixture dependency: ${id.name}`);
        },
      },
      () => {
        files = new FileEditorService();
        workspace = new VscodeWorkspaceCompatService();
        windowCompat = new VscodeWindowCompatService();
      },
    ),
  );
  try {
    const events: string[] = [];
    workspace!.onDidOpenTextDocument(() => events.push("open"));
    workspace!.onDidChangeTextDocument((event) =>
      events.push(`change:${event.contentChanges.length}`),
    );
    workspace!.onDidSaveTextDocument(() => events.push("save"));
    workspace!.onDidCloseTextDocument(() => events.push("close"));
    const doc = await workspace!.openTextDocument(path);
    const same = doc === (await workspace!.openTextDocument(Uri.file(path)));
    const applied = await workspace!.applyEdit([
      [doc.uri, [{ range: new Range(0, 1, 0, 2), newText: "B" }]],
    ]);
    await nextTick();
    const afterWorkspaceEdit = {
      text: doc.getText(),
      saved: saved.get("document.ts"),
      dirty: doc.isDirty,
    };
    const overlapping = await workspace!.applyEdit([
      [
        doc.uri,
        [
          { range: new Range(0, 0, 0, 2), newText: "first" },
          { range: new Range(0, 1, 0, 2), newText: "second" },
        ],
      ],
    ]);
    const partial = await workspace!.applyEdit([
      [doc.uri, [{ range: new Range(0, 0, 0, 1), newText: "X" }]],
      [Uri.file(`${root}/missing.ts`), [{ range: new Range(0, 0, 0, 0), newText: "missing" }]],
    ]);
    const beforeShow = doc.getText();
    const textEditor = await windowCompat!.showTextDocument(doc, {
      preview: false,
      selection: new Range(1, 0, 1, 2),
    });
    const selection = [textEditor.selection.active.line, textEditor.selection.active.character];
    let escapedBuilder: { insert(position: Position, text: string): void } | undefined;
    const editorApplied = await textEditor.edit((builder) => {
      escapedBuilder = builder;
      builder.insert(new Position(0, 0), "prefix ");
      builder.setEndOfLine(1);
    });
    await nextTick();
    const afterEditorEdit = editors[0]!.getValue();
    let builderRejected = false;
    try {
      escapedBuilder!.insert(new Position(0, 0), "late");
    } catch {
      builderRejected = true;
    }
    editors[0]!.trigger("fixture", "undo", null);
    await nextTick();
    const afterUndo = editors[0]!.getValue();
    const decoration = windowCompat!.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: { id: "editor.selectionBackground" },
    });
    textEditor.setDecorations(decoration, [
      { range: new Range(0, 0, 0, 1), hoverMessage: "hover text" },
    ]);
    const model = editors[0]!.getModel()!;
    const decorated = model
      .getAllDecorations()
      .find((item) => item.options.className === decoration.key);
    const decorationBefore = {
      count: decorated ? 1 : 0,
      wholeLine: decorated?.options.isWholeLine,
      hover: decorated?.options.hoverMessage,
    };
    decoration.dispose();
    const decorationAfter = model
      .getAllDecorations()
      .filter((item) => item.options.className === decoration.key).length;
    const savedSuccessfully = await doc.save();
    await nextTick();
    files!.closeDocument(path);
    await nextTick();
    return {
      same,
      applied,
      afterWorkspaceEdit,
      overlapping,
      partial,
      beforeShow,
      tabOpens,
      selection,
      editorApplied,
      afterEditorEdit,
      afterUndo,
      builderRejected,
      decorationBefore,
      decorationAfter,
      savedSuccessfully,
      closed: doc.isClosed,
      events,
    };
  } finally {
    registrations.forEach((dispose) => dispose());
    editors.forEach((editor) => editor.dispose());
    tabScopes.forEach((tabScope) => tabScope.stop());
    containers.forEach((container) => container.remove());
    scope.stop();
  }
}
