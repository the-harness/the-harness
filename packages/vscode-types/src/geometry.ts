export class Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    if (line < 0 || character < 0) throw new Error("Position must be non-negative");
    this.line = line;
    this.character = character;
  }

  static isPosition(value: unknown): value is Position {
    if (!value || typeof value !== "object") return false;
    const position = value as Position;
    return typeof position.line === "number" && typeof position.character === "number";
  }

  static of(position: Pick<Position, "line" | "character">): Position {
    return position instanceof Position
      ? position
      : new Position(position.line, position.character);
  }

  compareTo(other: Position): number {
    return Math.sign(this.line - other.line || this.character - other.character);
  }

  isBefore(other: Position): boolean {
    return this.compareTo(other) < 0;
  }
  isBeforeOrEqual(other: Position): boolean {
    return this.compareTo(other) <= 0;
  }
  isAfter(other: Position): boolean {
    return this.compareTo(other) > 0;
  }
  isAfterOrEqual(other: Position): boolean {
    return this.compareTo(other) >= 0;
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  translate(lineDelta?: number, characterDelta?: number): Position;
  translate(change: { lineDelta?: number; characterDelta?: number }): Position;
  translate(
    change: number | { lineDelta?: number; characterDelta?: number } = 0,
    characterDelta = 0,
  ): Position {
    if (change === null || characterDelta === null) throw new Error("Invalid position change");
    const lineDelta = typeof change === "number" ? change : (change.lineDelta ?? 0);
    characterDelta = typeof change === "number" ? characterDelta : (change.characterDelta ?? 0);
    return lineDelta === 0 && characterDelta === 0
      ? this
      : new Position(this.line + lineDelta, this.character + characterDelta);
  }

  with(line?: number, character?: number): Position;
  with(change: { line?: number; character?: number }): Position;
  with(
    change: number | { line?: number; character?: number } = this.line,
    character = this.character,
  ): Position {
    if (change === null || character === null) throw new Error("Invalid position change");
    const line = typeof change === "number" ? change : (change.line ?? this.line);
    character = typeof change === "number" ? character : (change.character ?? this.character);
    return line === this.line && character === this.character
      ? this
      : new Position(line, character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(
    start: Position | number,
    end: Position | number,
    endLine?: number,
    endCharacter?: number,
  ) {
    let first: Position;
    let last: Position;
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      typeof endLine === "number" &&
      typeof endCharacter === "number"
    ) {
      first = new Position(start, end);
      last = new Position(endLine, endCharacter);
    } else if (Position.isPosition(start) && Position.isPosition(end)) {
      first = Position.of(start);
      last = Position.of(end);
    } else {
      throw new Error("Invalid range arguments");
    }
    [this.start, this.end] = first.isBefore(last) ? [first, last] : [last, first];
  }

  static isRange(value: unknown): value is Range {
    if (!value || typeof value !== "object") return false;
    const range = value as Range;
    return Position.isPosition(range.start) && Position.isPosition(range.end);
  }

  static of(range: Pick<Range, "start" | "end">): Range {
    return range instanceof Range ? range : new Range(range.start, range.end);
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    if (Range.isRange(positionOrRange))
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    return (
      Position.isPosition(positionOrRange) &&
      this.start.isBeforeOrEqual(positionOrRange) &&
      this.end.isAfterOrEqual(positionOrRange)
    );
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(other: Range): Range | undefined {
    other = Range.of(other);
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }

  union(other: Range): Range {
    other = Range.of(other);
    if (this.contains(other)) return this;
    if (other.contains(this)) return other;
    return new Range(
      this.start.isBefore(other.start) ? this.start : other.start,
      this.end.isAfter(other.end) ? this.end : other.end,
    );
  }

  with(start?: Position, end?: Position): Range;
  with(change: { start?: Position; end?: Position }): Range;
  with(
    change: Position | { start?: Position; end?: Position } = this.start,
    end = this.end,
  ): Range {
    if (change === null || end === null) throw new Error("Invalid range change");
    const start = Position.isPosition(change) ? change : (change.start ?? this.start);
    end = Position.isPosition(change) ? end : (change.end ?? this.end);
    return this.start.isEqual(start) && this.end.isEqual(end) ? this : new Range(start, end);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(
    anchorLine: number,
    anchorCharacter: number,
    activeLine: number,
    activeCharacter: number,
  );
  constructor(
    anchor: Position | number,
    active: Position | number,
    activeLine?: number,
    activeCharacter?: number,
  ) {
    const first =
      typeof anchor === "number" && typeof active === "number"
        ? new Position(anchor, active)
        : Position.isPosition(anchor)
          ? Position.of(anchor)
          : undefined;
    const last =
      typeof activeLine === "number" && typeof activeCharacter === "number"
        ? new Position(activeLine, activeCharacter)
        : Position.isPosition(active)
          ? Position.of(active)
          : undefined;
    if (!first || !last) throw new Error("Invalid selection arguments");
    super(first, last);
    this.anchor = first;
    this.active = last;
  }

  get isReversed(): boolean {
    return this.anchor === this.end;
  }
}
