// Value-object behavior follows microsoft/vscode 1f8d8b2; see ../LICENSE.vscode.
import { EndOfLine } from "./enums.ts";
import { Position, Range } from "./geometry.ts";
import type { Diagnostic } from "./language-values.ts";
import { Uri } from "./uri.ts";
import { NotebookEdit } from "./notebook-values.ts";

export class MarkdownString {
  value: string;
  isTrusted?: boolean | { readonly enabledCommands: readonly string[] };
  supportThemeIcons?: boolean;
  supportHtml = false;
  baseUri?: Uri;

  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }

  appendText(value: string): this {
    if (this.supportThemeIcons)
      value = value.replace(
        /(\\)?\$\([a-z0-9-]+(?:~[a-z0-9-]+)?\)/gi,
        (match, escaped: string | undefined) => (escaped ? match : `\\${match}`),
      );
    this.value += value
      .replace(/[\\`*_{}[\]()#+!~]/g, "\\$&")
      .replace(/^([ \t]*)-/gm, "$1\\-")
      .replace(/[ \t]+/g, (space) => "&nbsp;".repeat(space.length))
      .replace(/>/g, "\\>")
      .replace(/\n/g, "\n\n");
    return this;
  }

  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language = ""): this {
    const longest = (value.match(/^ {0,3}`+/gm) ?? []).reduce(
      (length, match) => Math.max(length, match.trimStart().length),
      0,
    );
    const fence = "`".repeat(Math.max(3, longest + 1));
    this.value += `\n${fence}${language}\n${value}\n${fence}\n`;
    return this;
  }
}

export class SnippetString {
  value: string;
  private tabstop = 1;

  constructor(value = "") {
    this.value = value;
  }

  static isSnippetString(value: unknown): value is SnippetString {
    return (
      !!value && typeof value === "object" && typeof (value as SnippetString).value === "string"
    );
  }

  appendText(value: string): this {
    this.value += value.replace(/\$|}|\\/g, "\\$&");
    return this;
  }

  appendTabstop(number = this.tabstop++): this {
    this.value += `$${number}`;
    return this;
  }

  appendPlaceholder(
    value: string | ((snippet: SnippetString) => unknown),
    number = this.tabstop++,
  ): this {
    let text: string;
    if (typeof value === "function") {
      const nested = new SnippetString();
      nested.tabstop = this.tabstop;
      value(nested);
      this.tabstop = nested.tabstop;
      text = nested.value;
    } else {
      text = value.replace(/\$|}|\\/g, "\\$&");
    }
    this.value += "${" + number + ":" + text + "}";
    return this;
  }

  appendChoice(values: readonly string[], number = this.tabstop++): this {
    this.value +=
      "${" +
      number +
      "|" +
      values.map((value) => value.replace(/[|\\,]/g, "\\$&")).join(",") +
      "|}";
    return this;
  }

  appendVariable(
    name: string,
    defaultValue?: string | ((snippet: SnippetString) => unknown),
  ): this {
    let text: string | undefined;
    if (typeof defaultValue === "function") {
      const nested = new SnippetString();
      nested.tabstop = this.tabstop;
      defaultValue(nested);
      this.tabstop = nested.tabstop;
      text = nested.value;
    } else {
      text = defaultValue?.replace(/\$|}/g, "\\$&");
    }
    this.value += "${" + name + (text ? ":" + text : "") + "}";
    return this;
  }
}

export class TextEdit {
  range: Range;
  newText: string;
  newEol?: EndOfLine;

  constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, "");
  }
  static setEndOfLine(eol: EndOfLine): TextEdit {
    const edit = new TextEdit(new Range(0, 0, 0, 0), "");
    edit.newEol = eol;
    return edit;
  }
}

export class SnippetTextEdit {
  range: Range;
  snippet: SnippetString;
  keepWhitespace?: boolean;

  constructor(range: Range, snippet: SnippetString) {
    this.range = range;
    this.snippet = snippet;
  }
  static isSnippetTextEdit(value: unknown): value is SnippetTextEdit {
    return (
      !!value &&
      typeof value === "object" &&
      Range.isRange((value as SnippetTextEdit).range) &&
      SnippetString.isSnippetString((value as SnippetTextEdit).snippet)
    );
  }
  static replace(range: Range, snippet: SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(range, snippet);
  }
  static insert(position: Position, snippet: SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(new Range(position, position), snippet);
  }
}

export interface WorkspaceEditEntryMetadata {
  readonly needsConfirmation: boolean;
  readonly label: string;
  readonly description?: string;
  readonly iconPath?: Uri | { light: Uri; dark: Uri };
}

export interface FileOperationOptions {
  readonly overwrite?: boolean;
  readonly ignoreIfExists?: boolean;
  readonly ignoreIfNotExists?: boolean;
  readonly recursive?: boolean;
  readonly contents?: Uint8Array;
}

export type WorkspaceEditEntry =
  | {
      readonly type: "text";
      readonly uri: Uri;
      readonly edit: TextEdit;
      readonly metadata?: WorkspaceEditEntryMetadata;
    }
  | {
      readonly type: "snippet";
      readonly uri: Uri;
      readonly edit: SnippetTextEdit;
      readonly metadata?: WorkspaceEditEntryMetadata;
    }
  | {
      readonly type: "notebook";
      readonly uri: Uri;
      readonly edit: NotebookEdit;
      readonly metadata?: WorkspaceEditEntryMetadata;
    }
  | {
      readonly type: "create" | "delete";
      readonly uri: Uri;
      readonly options?: FileOperationOptions;
      readonly metadata?: WorkspaceEditEntryMetadata;
    }
  | {
      readonly type: "rename";
      readonly uri: Uri;
      readonly target: Uri;
      readonly options?: FileOperationOptions;
      readonly metadata?: WorkspaceEditEntryMetadata;
    };

export class WorkspaceEdit {
  private edits: WorkspaceEditEntry[] = [];

  get size(): number {
    return this.entries().length;
  }

  replace(uri: Uri, range: Range, newText: string, metadata?: WorkspaceEditEntryMetadata): void {
    this.edits.push({ type: "text", uri, edit: new TextEdit(range, newText), metadata });
  }
  insert(
    uri: Uri,
    position: Position,
    newText: string,
    metadata?: WorkspaceEditEntryMetadata,
  ): void {
    this.replace(uri, new Range(position, position), newText, metadata);
  }
  delete(uri: Uri, range: Range, metadata?: WorkspaceEditEntryMetadata): void {
    this.replace(uri, range, "", metadata);
  }

  has(uri: Uri): boolean {
    return this.edits.some(
      (entry) => entry.type === "text" && entry.uri.toString() === uri.toString(),
    );
  }
  get(uri: Uri): TextEdit[] {
    return this.edits.flatMap((entry) =>
      entry.type === "text" && entry.uri.toString() === uri.toString() ? [entry.edit] : [],
    );
  }

  set(
    uri: Uri,
    edits:
      | readonly (
          | TextEdit
          | SnippetTextEdit
          | NotebookEdit
          | [TextEdit | SnippetTextEdit | NotebookEdit, WorkspaceEditEntryMetadata | undefined]
        )[]
      | undefined
      | null,
  ): void {
    if (!edits) {
      this.edits = this.edits.filter(
        (entry) =>
          !(
            (entry.type === "text" || entry.type === "snippet" || entry.type === "notebook") &&
            entry.uri.toString() === uri.toString()
          ),
      );
      return;
    }
    for (const value of edits) {
      if (!value) continue;
      let edit: TextEdit | SnippetTextEdit | NotebookEdit;
      let metadata: WorkspaceEditEntryMetadata | undefined;
      if (Array.isArray(value)) [edit, metadata] = value;
      else edit = value;
      if (edit instanceof NotebookEdit) this.edits.push({ type: "notebook", uri, edit, metadata });
      else if (SnippetTextEdit.isSnippetTextEdit(edit))
        this.edits.push({ type: "snippet", uri, edit, metadata });
      else this.edits.push({ type: "text", uri, edit, metadata });
    }
  }

  createFile(
    uri: Uri,
    options?: FileOperationOptions,
    metadata?: WorkspaceEditEntryMetadata,
  ): void {
    this.edits.push({ type: "create", uri, options, metadata });
  }
  deleteFile(
    uri: Uri,
    options?: FileOperationOptions,
    metadata?: WorkspaceEditEntryMetadata,
  ): void {
    this.edits.push({ type: "delete", uri, options, metadata });
  }
  renameFile(
    uri: Uri,
    target: Uri,
    options?: FileOperationOptions,
    metadata?: WorkspaceEditEntryMetadata,
  ): void {
    this.edits.push({ type: "rename", uri, target, options, metadata });
  }

  entries(): [Uri, TextEdit[]][] {
    const grouped = new Map<string, [Uri, TextEdit[]]>();
    for (const entry of this.edits) {
      if (entry.type !== "text") continue;
      const key = entry.uri.toString();
      let group = grouped.get(key);
      if (!group) {
        group = [entry.uri, []];
        grouped.set(key, group);
      }
      group[1].push(entry.edit);
    }
    return [...grouped.values()];
  }

  _allEntries(): readonly WorkspaceEditEntry[] {
    return this.edits;
  }
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");
  static readonly RefactorExtract = new CodeActionKind("refactor.extract");
  static readonly RefactorInline = new CodeActionKind("refactor.inline");
  static readonly RefactorMove = new CodeActionKind("refactor.move");
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite");
  static readonly Source = new CodeActionKind("source");
  static readonly SourceOrganizeImports = new CodeActionKind("source.organizeImports");
  static readonly SourceFixAll = new CodeActionKind("source.fixAll");
  static readonly Notebook = new CodeActionKind("notebook");
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
  append(parts: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${parts}` : parts);
  }
  contains(other: CodeActionKind): boolean {
    return this.value === other.value || other.value.startsWith(`${this.value}.`);
  }
  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this);
  }
}

export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: unknown[];
}

export class CodeAction {
  title: string;
  kind?: CodeActionKind;
  edit?: WorkspaceEdit;
  command?: Command;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };

  constructor(title: string, kind?: CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }
}
