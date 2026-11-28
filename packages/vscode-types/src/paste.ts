import type { SnippetString, WorkspaceEdit } from "./editing.ts";

export class DataTransferItem {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
  async asString(): Promise<string> {
    return typeof this.value === "string" ? this.value : JSON.stringify(this.value);
  }
  asFile(): undefined {
    return undefined;
  }
}

export class DataTransfer implements Iterable<[string, DataTransferItem]> {
  private readonly items = new Map<string, DataTransferItem[]>();

  constructor(entries?: Iterable<readonly [string, DataTransferItem]>) {
    for (const [mime, item] of entries ?? []) {
      const key = mime.toLowerCase();
      this.items.set(key, [...(this.items.get(key) ?? []), item]);
    }
  }

  get(mimeType: string): DataTransferItem | undefined {
    return this.items.get(mimeType.toLowerCase())?.[0];
  }
  set(mimeType: string, value: DataTransferItem): void {
    this.items.set(mimeType.toLowerCase(), [value]);
  }
  forEach(
    callback: (item: DataTransferItem, mimeType: string, transfer: DataTransfer) => unknown,
    thisArg?: unknown,
  ): void {
    for (const [mime, item] of this) callback.call(thisArg, item, mime, this);
  }
  *[Symbol.iterator](): IterableIterator<[string, DataTransferItem]> {
    for (const [mime, entries] of this.items) for (const item of entries) yield [mime, item];
  }
}

export class DocumentDropOrPasteEditKind {
  static readonly Empty = new DocumentDropOrPasteEditKind("");
  static readonly Text = new DocumentDropOrPasteEditKind("text");
  static readonly TextUpdateImports = new DocumentDropOrPasteEditKind("text.updateImports");
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  append(...parts: string[]): DocumentDropOrPasteEditKind {
    return new DocumentDropOrPasteEditKind((this.value ? [this.value, ...parts] : parts).join("."));
  }
  contains(other: DocumentDropOrPasteEditKind): boolean {
    return this.value === other.value || other.value.startsWith(`${this.value}.`);
  }
  intersects(other: DocumentDropOrPasteEditKind): boolean {
    return this.contains(other) || other.contains(this);
  }
}

export class DocumentPasteEdit {
  insertText: string | SnippetString;
  title: string;
  kind: DocumentDropOrPasteEditKind;
  additionalEdit?: WorkspaceEdit;
  yieldTo?: readonly DocumentDropOrPasteEditKind[];
  constructor(
    insertText: string | SnippetString,
    title: string,
    kind: DocumentDropOrPasteEditKind,
  ) {
    this.insertText = insertText;
    this.title = title;
    this.kind = kind;
  }
}

export class DocumentDropEdit {
  insertText: string | SnippetString;
  title?: string;
  kind?: DocumentDropOrPasteEditKind;
  additionalEdit?: WorkspaceEdit;
  yieldTo?: readonly DocumentDropOrPasteEditKind[];
  constructor(
    insertText: string | SnippetString,
    title?: string,
    kind?: DocumentDropOrPasteEditKind,
  ) {
    this.insertText = insertText;
    this.title = title;
    this.kind = kind;
  }
}
