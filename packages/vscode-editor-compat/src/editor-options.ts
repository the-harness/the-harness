import {
  normalizeTextEditorOptions,
  TextEditorCursorStyle,
  TextEditorLineNumbersStyle,
  type ResolvedTextEditorOptions,
  type TextEditorOptions,
} from "@harness/vscode-types";
import * as monaco from "monaco-editor";

const cursorStyles = {
  [TextEditorCursorStyle.Line]: "line",
  [TextEditorCursorStyle.Block]: "block",
  [TextEditorCursorStyle.Underline]: "underline",
  [TextEditorCursorStyle.LineThin]: "line-thin",
  [TextEditorCursorStyle.BlockOutline]: "block-outline",
  [TextEditorCursorStyle.UnderlineThin]: "underline-thin",
} as const;

const lineNumberStyles = {
  [TextEditorLineNumbersStyle.Off]: "off",
  [TextEditorLineNumbersStyle.On]: "on",
  [TextEditorLineNumbersStyle.Relative]: "relative",
  [TextEditorLineNumbersStyle.Interval]: "interval",
} as const;

export function readEditorOptions(
  editor: monaco.editor.IStandaloneCodeEditor,
): ResolvedTextEditorOptions {
  const model = editor.getModel()?.getOptions();
  const lineNumbers = editor.getOption(monaco.editor.EditorOption.lineNumbers).renderType;
  const cursorStyle = editor.getOption(monaco.editor.EditorOption.cursorStyle);
  return {
    tabSize: model?.tabSize ?? 4,
    indentSize: model?.indentSize ?? model?.tabSize ?? 4,
    insertSpaces: model?.insertSpaces ?? true,
    cursorStyle: cursorStyle as TextEditorCursorStyle,
    lineNumbers:
      lineNumbers === monaco.editor.RenderLineNumbersType.Custom
        ? TextEditorLineNumbersStyle.On
        : (lineNumbers as TextEditorLineNumbersStyle),
  };
}

export function applyEditorOptions(
  editor: monaco.editor.IStandaloneCodeEditor,
  value: TextEditorOptions,
): void {
  const { tabSize, indentSize, insertSpaces, cursorStyle, lineNumbers } =
    normalizeTextEditorOptions(value);
  const model = editor.getModel();
  if (model && (tabSize !== undefined || indentSize !== undefined || insertSpaces !== undefined)) {
    if (tabSize === "auto" || insertSpaces === "auto") {
      const current = model.getOptions();
      model.detectIndentation(
        typeof insertSpaces === "boolean" ? insertSpaces : current.insertSpaces,
        typeof tabSize === "number" ? tabSize : current.tabSize,
      );
    }
    const current = model.getOptions();
    model.updateOptions({
      tabSize: typeof tabSize === "number" ? tabSize : current.tabSize,
      indentSize: indentSize ?? current.originalIndentSize,
      insertSpaces: typeof insertSpaces === "boolean" ? insertSpaces : current.insertSpaces,
    });
  }
  if (cursorStyle !== undefined || lineNumbers !== undefined) {
    const options: monaco.editor.IEditorOptions = {};
    if (cursorStyle !== undefined) options.cursorStyle = cursorStyles[cursorStyle];
    if (lineNumbers !== undefined) options.lineNumbers = lineNumberStyles[lineNumbers];
    editor.updateOptions(options);
  }
}

export function observeEditorOptions(
  editor: monaco.editor.IStandaloneCodeEditor,
  notify: (options: ResolvedTextEditorOptions) => void,
) {
  let previous = JSON.stringify(readEditorOptions(editor));
  let queued = false;
  let disposed = false;
  const observe = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      const options = readEditorOptions(editor);
      const next = JSON.stringify(options);
      if (next === previous) return;
      previous = next;
      notify(options);
    });
  };
  const subscriptions = [
    editor.onDidChangeModel(observe),
    editor.onDidChangeModelOptions(observe),
    editor.onDidChangeConfiguration(observe),
  ];
  return {
    dispose() {
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
