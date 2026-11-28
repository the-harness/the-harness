export const NotebookCellKind = { Markup: 1, Code: 2 } as const;
export type NotebookCellKind = (typeof NotebookCellKind)[keyof typeof NotebookCellKind];

export class NotebookRange {
  readonly start: number;
  readonly end: number;
  constructor(start: number, end: number) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0)
      throw new Error("Invalid notebook range");
    this.start = Math.min(start, end);
    this.end = Math.max(start, end);
  }
  get isEmpty(): boolean {
    return this.start === this.end;
  }
  with(change: { start?: number; end?: number }): NotebookRange {
    const start = change.start ?? this.start,
      end = change.end ?? this.end;
    return start === this.start && end === this.end ? this : new NotebookRange(start, end);
  }
}

export class NotebookCellOutputItem {
  data: Uint8Array;
  mime: string;
  constructor(data: Uint8Array, mime: string) {
    if (!(data instanceof Uint8Array) || typeof mime !== "string")
      throw new TypeError("Invalid notebook output item");
    this.data = data;
    this.mime = mime;
  }
  static text(value: string, mime = "text/plain"): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
  }
  static json(value: unknown, mime = "application/json"): NotebookCellOutputItem {
    return this.text(JSON.stringify(value), mime);
  }
  static stdout(value: string): NotebookCellOutputItem {
    return this.text(value, "application/vnd.code.notebook.stdout");
  }
  static stderr(value: string): NotebookCellOutputItem {
    return this.text(value, "application/vnd.code.notebook.stderr");
  }
  static error(value: Error): NotebookCellOutputItem {
    return this.json(
      { name: value.name, message: value.message, stack: value.stack },
      "application/vnd.code.notebook.error",
    );
  }
}

export class NotebookCellOutput {
  items: NotebookCellOutputItem[];
  metadata?: Record<string, unknown>;
  constructor(items: NotebookCellOutputItem[], metadata?: Record<string, unknown>) {
    this.items = items;
    this.metadata = metadata;
  }
}

export class NotebookCellData {
  kind: NotebookCellKind;
  value: string;
  languageId: string;
  metadata?: Record<string, unknown>;
  outputs?: NotebookCellOutput[];
  executionSummary?: {
    executionOrder?: number;
    success?: boolean;
    timing?: { startTime: number; endTime: number };
  };
  constructor(kind: NotebookCellKind, value: string, languageId: string) {
    this.kind = kind;
    this.value = value;
    this.languageId = languageId;
  }
}

export class NotebookData {
  cells: NotebookCellData[];
  metadata?: Record<string, unknown>;
  constructor(cells: NotebookCellData[]) {
    this.cells = cells;
  }
}

export class NotebookEdit {
  range: NotebookRange;
  newCells: NotebookCellData[];
  newCellMetadata?: Record<string, unknown>;
  newNotebookMetadata?: Record<string, unknown>;
  constructor(range: NotebookRange, newCells: NotebookCellData[]) {
    this.range = range;
    this.newCells = newCells;
  }
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(range, newCells);
  }
  static insertCells(index: number, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }
  static deleteCells(range: NotebookRange): NotebookEdit {
    return new NotebookEdit(range, []);
  }
  static updateCellMetadata(index: number, metadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(index, index), []);
    edit.newCellMetadata = metadata;
    return edit;
  }
  static updateNotebookMetadata(metadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(0, 0), []);
    edit.newNotebookMetadata = metadata;
    return edit;
  }
}
