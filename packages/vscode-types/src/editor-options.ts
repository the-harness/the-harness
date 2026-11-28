import { TextEditorCursorStyle, TextEditorLineNumbersStyle } from "./enums.ts";

export interface TextEditorOptions {
  tabSize?: number | string;
  indentSize?: number | string;
  insertSpaces?: boolean | string;
  cursorStyle?: TextEditorCursorStyle;
  lineNumbers?: TextEditorLineNumbersStyle;
}

export interface ResolvedTextEditorOptions {
  tabSize: number;
  indentSize: number;
  insertSpaces: boolean;
  cursorStyle: TextEditorCursorStyle;
  lineNumbers: TextEditorLineNumbersStyle;
}

interface TextEditorOptionsUpdate {
  tabSize?: number | "auto";
  indentSize?: number | "tabSize";
  insertSpaces?: boolean | "auto";
  cursorStyle?: TextEditorCursorStyle;
  lineNumbers?: TextEditorLineNumbersStyle;
}

function positiveInteger(value: number | string | undefined): number | undefined {
  const size =
    typeof value === "number"
      ? Math.floor(value)
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

export function normalizeTextEditorOptions(options: TextEditorOptions): TextEditorOptionsUpdate {
  const update: TextEditorOptionsUpdate = {};
  const tabSize = options.tabSize === "auto" ? "auto" : positiveInteger(options.tabSize);
  const indentSize =
    options.indentSize === "tabSize" ? "tabSize" : positiveInteger(options.indentSize);
  if (tabSize !== undefined) update.tabSize = tabSize;
  if (indentSize !== undefined) update.indentSize = indentSize;
  if (options.insertSpaces !== undefined) {
    update.insertSpaces =
      options.insertSpaces === "auto"
        ? "auto"
        : options.insertSpaces !== "false" && !!options.insertSpaces;
  }
  if (
    typeof options.cursorStyle === "number" &&
    typeof TextEditorCursorStyle[options.cursorStyle] === "string"
  ) {
    update.cursorStyle = options.cursorStyle;
  }
  if (
    typeof options.lineNumbers === "number" &&
    typeof TextEditorLineNumbersStyle[options.lineNumbers] === "string"
  ) {
    update.lineNumbers = options.lineNumbers;
  }
  return update;
}
