import {
  Position,
  Range,
  Selection,
  Uri,
  type TextEditor,
  type TextEditorDecorationType,
  type VscodeWindowCompatService,
  type VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { SnippetString, type TextEditorOptions } from "@harness/vscode-types";

export function serializeEditor(editor: TextEditor) {
  return {
    document: editor.document.toJSON(),
    selections: editor.selections,
    visibleRanges: editor.visibleRanges,
    viewColumn: editor.viewColumn,
    options: editor.options,
  };
}

export function createMainThreadEditor(
  window: Pick<
    VscodeWindowCompatService,
    "activeTextEditor" | "visibleTextEditors" | "createTextEditorDecorationType"
  >,
  workspace: Pick<VscodeWorkspaceCompatService, "getTextDocument">,
) {
  const decorationTypes = new Map<string, TextEditorDecorationType>();

  function findEditor(rawUri: Parameters<typeof Uri.from>[0]): TextEditor | undefined {
    const key = Uri.from(rawUri).toString();
    return window.visibleTextEditors.value.find((editor) => editor.document.uri.toString() === key);
  }

  async function handle(method: string, args: unknown[]): Promise<unknown> {
    if (method === "window.createDecorationType") {
      const [key, options] = args as [string, Record<string, string>];
      decorationTypes.set(key, window.createTextEditorDecorationType(options));
      return undefined;
    }
    if (method === "window.disposeDecorationType") {
      const [key] = args as [string];
      decorationTypes.get(key)?.dispose();
      decorationTypes.delete(key);
      return undefined;
    }
    if (method === "editor.setDecorations") {
      const [key, ranges, rawUri] = args as [
        string,
        Parameters<TextEditor["setDecorations"]>[1],
        Parameters<typeof Uri.from>[0]?,
      ];
      const deco = decorationTypes.get(key);
      const editor = rawUri ? findEditor(rawUri) : window.activeTextEditor.value;
      if (deco && editor) editor.setDecorations(deco, ranges);
      return undefined;
    }
    if (method.startsWith("editor.")) {
      const [rawUri, ...rest] = args as [Parameters<typeof Uri.from>[0], ...unknown[]];
      const editor = findEditor(rawUri);
      if (!editor) {
        if (method === "editor.edit" || method === "editor.insertSnippet") return false;
        throw new Error("Text editor is no longer visible");
      }
      if (method === "editor.setSelections") {
        editor.selections = (rest[0] as Selection[]).map(
          (value) => new Selection(Position.of(value.anchor), Position.of(value.active)),
        );
      } else if (method === "editor.setOptions") {
        editor.options = rest[0] as TextEditorOptions;
      } else if (method === "editor.revealRange") {
        editor.revealRange(Range.of(rest[0] as Range), rest[1] as number);
      } else if (method === "editor.insertSnippet") {
        const [version, value, ranges, options] = rest as [
          number,
          string,
          Range[] | undefined,
          Parameters<TextEditor["insertSnippet"]>[2],
        ];
        if (editor.document.version !== version) return false;
        const applied = await editor.insertSnippet(
          new SnippetString(value),
          ranges?.map(Range.of),
          options ?? {},
        );
        const document = workspace.getTextDocument(editor.document.fileName) ?? editor.document;
        return { applied, document: document.toJSON(), selections: editor.selections };
      } else if (method === "editor.edit") {
        const [version, edits, endOfLine, options] = rest as [
          number,
          { range: Range; text: string }[],
          1 | 2 | undefined,
          Parameters<TextEditor["edit"]>[1],
        ];
        if (editor.document.version !== version) return false;
        const applied = await editor.edit((builder) => {
          for (const edit of edits) builder.replace(Range.of(edit.range), edit.text);
          if (endOfLine) builder.setEndOfLine(endOfLine);
        }, options ?? {});
        const document = workspace.getTextDocument(editor.document.fileName) ?? editor.document;
        return { applied, document: document.toJSON() };
      } else throw new Error(`Unsupported editor operation: ${method}`);
      return undefined;
    }
    return undefined;
  }

  function dispose(): void {
    for (const decoration of decorationTypes.values()) decoration.dispose();
  }

  return { handle, dispose };
}
