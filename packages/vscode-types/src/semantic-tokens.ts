import { Range } from "./geometry.ts";

export class SemanticTokensLegend {
  readonly tokenTypes: string[];
  readonly tokenModifiers: string[];

  constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}

export class SemanticTokens {
  readonly data: Uint32Array;
  readonly resultId: string | undefined;

  constructor(data: Uint32Array, resultId?: string) {
    this.data = data;
    this.resultId = resultId;
  }
}

export class SemanticTokensBuilder {
  private readonly tokens: [
    line: number,
    character: number,
    length: number,
    type: number,
    modifiers: number,
  ][] = [];
  private readonly tokenTypes = new Map<string, number>();
  private readonly tokenModifiers = new Map<string, number>();
  private readonly hasLegend: boolean;
  private sorted = true;

  constructor(legend?: SemanticTokensLegend) {
    this.hasLegend = !!legend;
    legend?.tokenTypes.forEach((type, index) => this.tokenTypes.set(type, index));
    legend?.tokenModifiers.forEach((modifier, index) => this.tokenModifiers.set(modifier, index));
  }

  push(
    line: number,
    character: number,
    length: number,
    tokenType: number,
    tokenModifiers?: number,
  ): void;
  push(range: Range, tokenType: string, tokenModifiers?: string[]): void;
  push(
    lineOrRange: number | Range,
    characterOrType: number | string,
    lengthOrModifiers?: number | string[],
    tokenType?: number,
    tokenModifiers?: number,
  ): void {
    if (
      typeof lineOrRange === "number" &&
      typeof characterOrType === "number" &&
      typeof lengthOrModifiers === "number" &&
      typeof tokenType === "number" &&
      (tokenModifiers === undefined || typeof tokenModifiers === "number")
    ) {
      this.add(lineOrRange, characterOrType, lengthOrModifiers, tokenType, tokenModifiers ?? 0);
      return;
    }
    if (
      !Range.isRange(lineOrRange) ||
      typeof characterOrType !== "string" ||
      (lengthOrModifiers !== undefined &&
        (!Array.isArray(lengthOrModifiers) ||
          !lengthOrModifiers.every((value) => typeof value === "string")))
    ) {
      throw new Error("Illegal argument");
    }
    if (!this.hasLegend) throw new Error("Legend must be provided in constructor");
    if (lineOrRange.start.line !== lineOrRange.end.line)
      throw new Error("`range` cannot span multiple lines");
    const type = this.tokenTypes.get(characterOrType);
    if (type === undefined) throw new Error("`tokenType` is not in the provided legend");
    let modifiers = 0;
    for (const name of lengthOrModifiers ?? []) {
      const index = this.tokenModifiers.get(name);
      if (index === undefined) throw new Error("`tokenModifier` is not in the provided legend");
      modifiers |= (1 << index) >>> 0;
    }
    this.add(
      lineOrRange.start.line,
      lineOrRange.start.character,
      lineOrRange.end.character - lineOrRange.start.character,
      type,
      modifiers,
    );
  }

  private add(
    line: number,
    character: number,
    length: number,
    type: number,
    modifiers: number,
  ): void {
    const previous = this.tokens.at(-1);
    if (previous && (line < previous[0] || (line === previous[0] && character < previous[1])))
      this.sorted = false;
    this.tokens.push([line, character, length, type, modifiers]);
  }

  build(resultId?: string): SemanticTokens {
    const tokens = this.sorted
      ? this.tokens
      : [...this.tokens].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const data = new Uint32Array(tokens.length * 5);
    let previousLine = 0;
    let previousCharacter = 0;
    for (let index = 0; index < tokens.length; index++) {
      const [line, character, length, type, modifiers] = tokens[index]!;
      const deltaLine = line - previousLine;
      data.set(
        [
          deltaLine,
          deltaLine === 0 ? character - previousCharacter : character,
          length,
          type,
          modifiers,
        ],
        index * 5,
      );
      previousLine = line;
      previousCharacter = character;
    }
    return new SemanticTokens(data, resultId);
  }
}

export class SemanticTokensEdit {
  readonly start: number;
  readonly deleteCount: number;
  readonly data: Uint32Array | undefined;

  constructor(start: number, deleteCount: number, data?: Uint32Array) {
    this.start = start;
    this.deleteCount = deleteCount;
    this.data = data;
  }
}

export class SemanticTokensEdits {
  readonly edits: SemanticTokensEdit[];
  readonly resultId: string | undefined;

  constructor(edits: SemanticTokensEdit[], resultId?: string) {
    this.edits = edits;
    this.resultId = resultId;
  }
}
