import { Position, Range } from "./geometry.ts";
import { Uri } from "./uri.ts";

export interface TextDocumentSnapshot {
  readonly uri: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  };
  readonly text: string;
  readonly version: number;
  readonly languageId: string;
  readonly isDirty: boolean;
  readonly eol: 1 | 2;
  readonly encoding?: string;
  readonly isClosed?: boolean;
  readonly isUntitled?: boolean;
}

export class TextDocumentData {
  readonly uri: Uri;
  private snapshot: TextDocumentSnapshot;
  private lines: string[] = [];
  private offsets: number[] = [];
  private readonly saveDocument?: () => Promise<boolean>;

  constructor(snapshot: TextDocumentSnapshot, saveDocument?: () => Promise<boolean>) {
    this.saveDocument = saveDocument;
    this.uri = Uri.from(snapshot.uri);
    this.snapshot = snapshot;
    this.update(snapshot);
  }

  update(snapshot: TextDocumentSnapshot): void {
    this.snapshot = snapshot;
    this.lines = [];
    this.offsets = [];
    const breaks = /\r\n|\r|\n/g;
    let start = 0;
    for (const match of snapshot.text.matchAll(breaks)) {
      this.offsets.push(start);
      this.lines.push(snapshot.text.slice(start, match.index));
      start = match.index + match[0].length;
    }
    this.offsets.push(start);
    this.lines.push(snapshot.text.slice(start));
  }

  toJSON(): TextDocumentSnapshot {
    return { ...this.snapshot, uri: this.uri.toJSON() };
  }

  get fileName(): string {
    return this.uri.fsPath;
  }
  get isUntitled(): boolean {
    return this.snapshot.isUntitled ?? this.uri.scheme === "untitled";
  }
  get languageId(): string {
    return this.snapshot.languageId;
  }
  get encoding(): string {
    return this.snapshot.encoding ?? "utf8";
  }
  get version(): number {
    return this.snapshot.version;
  }
  get isDirty(): boolean {
    return this.snapshot.isDirty;
  }
  get isClosed(): boolean {
    return this.snapshot.isClosed ?? false;
  }
  get eol(): 1 | 2 {
    return this.snapshot.eol;
  }
  get lineCount(): number {
    return this.lines.length;
  }

  getText(range?: Range): string {
    if (!range) return this.snapshot.text;
    const valid = this.validateRange(range);
    return this.snapshot.text.slice(this.offsetAt(valid.start), this.offsetAt(valid.end));
  }

  lineAt(lineOrPosition: number | Position) {
    const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    if (!Number.isInteger(line) || line < 0 || line >= this.lines.length) {
      throw new RangeError("Illegal value for line");
    }
    const text = this.lines[line]!;
    const range = new Range(new Position(line, 0), new Position(line, text.length));
    const first = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range,
      rangeIncludingLineBreak:
        line + 1 < this.lines.length ? new Range(range.start, new Position(line + 1, 0)) : range,
      firstNonWhitespaceCharacterIndex: first === -1 ? text.length : first,
      isEmptyOrWhitespace: first === -1,
    };
  }

  positionAt(offset: number): Position {
    const bounded = Math.min(this.snapshot.text.length, Math.max(0, Math.floor(offset)));
    let line = 0;
    while (line + 1 < this.offsets.length && this.offsets[line + 1]! <= bounded) line++;
    return new Position(line, Math.min(this.lines[line]!.length, bounded - this.offsets[line]!));
  }

  offsetAt(position: Position): number {
    const bounded = this.validatePosition(position);
    return this.offsets[bounded.line]! + bounded.character;
  }

  validatePosition(position: Position): Position {
    if (position.line < 0) return new Position(0, 0);
    if (position.line >= this.lines.length) {
      const last = this.lines.length - 1;
      return new Position(last, this.lines[last]!.length);
    }
    const line = Math.floor(position.line);
    const character = Math.min(
      this.lines[line]!.length,
      Math.max(0, Math.floor(position.character)),
    );
    return line === position.line && character === position.character
      ? position
      : new Position(line, character);
  }

  validateRange(range: Range): Range {
    const start = this.validatePosition(range.start);
    const end = this.validatePosition(range.end);
    return start === range.start && end === range.end ? range : new Range(start, end);
  }

  getWordRangeAtPosition(
    position: Position,
    regex = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+\[\]{}\\|;:'",.<>/?\s]+)/g,
  ): Range | undefined {
    const bounded = this.validatePosition(position);
    const flags = regex.flags.replace(/[gy]/g, "") + "g";
    const matcher = new RegExp(regex.source, flags);
    if (new RegExp(regex.source, regex.flags.replace(/[gy]/g, "")).test("")) {
      throw new Error("Word definition must not match the empty string");
    }
    for (const match of this.lines[bounded.line]!.matchAll(matcher)) {
      if (!match[0].length) throw new Error("Word definition must not match the empty string");
      if (match.index <= bounded.character && bounded.character <= match.index + match[0].length) {
        return new Range(
          new Position(bounded.line, match.index),
          new Position(bounded.line, match.index + match[0].length),
        );
      }
    }
    return undefined;
  }

  async save(): Promise<boolean> {
    return !this.isClosed && this.saveDocument ? await this.saveDocument() : false;
  }
}
