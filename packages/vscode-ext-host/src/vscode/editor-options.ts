import {
  normalizeTextEditorOptions,
  TextEditorCursorStyle,
  TextEditorLineNumbersStyle,
  type ResolvedTextEditorOptions,
  type TextEditorOptions,
} from "@harness/vscode-types";

export function createLiveEditorOptions(
  read: () => Partial<ResolvedTextEditorOptions>,
  apply: (update: TextEditorOptions) => void,
) {
  const options: TextEditorOptions = {
    get tabSize() {
      return read().tabSize ?? 4;
    },
    set tabSize(value: TextEditorOptions["tabSize"]) {
      assign({ tabSize: value });
    },
    get indentSize() {
      const value = read();
      return value.indentSize ?? value.tabSize ?? 4;
    },
    set indentSize(value: TextEditorOptions["indentSize"]) {
      assign({ indentSize: value });
    },
    get insertSpaces() {
      return read().insertSpaces ?? true;
    },
    set insertSpaces(value: TextEditorOptions["insertSpaces"]) {
      assign({ insertSpaces: value });
    },
    get cursorStyle() {
      return read().cursorStyle ?? TextEditorCursorStyle.Line;
    },
    set cursorStyle(value: TextEditorOptions["cursorStyle"]) {
      assign({ cursorStyle: value });
    },
    get lineNumbers() {
      return read().lineNumbers ?? TextEditorLineNumbersStyle.On;
    },
    set lineNumbers(value: TextEditorOptions["lineNumbers"]) {
      assign({ lineNumbers: value });
    },
  };

  function assign(value: TextEditorOptions): void {
    const update = normalizeTextEditorOptions(value);
    if (!Object.keys(update).length) return;

    const { tabSize, indentSize, insertSpaces, cursorStyle, lineNumbers } = update;
    const optimistic = read();
    if (typeof tabSize === "number") optimistic.tabSize = tabSize;
    if (typeof indentSize === "number") optimistic.indentSize = indentSize;
    if (typeof insertSpaces === "boolean") optimistic.insertSpaces = insertSpaces;
    if (cursorStyle !== undefined) optimistic.cursorStyle = cursorStyle;
    if (lineNumbers !== undefined) optimistic.lineNumbers = lineNumbers;
    apply(update);
  }

  return { options, assign };
}
