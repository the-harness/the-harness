export class LanguageModelTextPart {
  value: string;
  audience: number[] | undefined;
  constructor(value: string, audience?: number[]) {
    this.value = value;
    this.audience = audience;
  }
}

export const LanguageModelChatMessageRole = {
  User: 1,
  Assistant: 2,
  System: 3,
  1: "User",
  2: "Assistant",
  3: "System",
} as const;
export type LanguageModelChatMessageRole = 1 | 2 | 3;
export const LanguageModelChatToolMode = {
  Auto: 1,
  Required: 2,
  1: "Auto",
  2: "Required",
} as const;
export type LanguageModelChatToolMode = 1 | 2;
export const LanguageModelPartAudience = {
  Assistant: 0,
  User: 1,
  Extension: 2,
  0: "Assistant",
  1: "User",
  2: "Extension",
} as const;
export type LanguageModelPartAudience = 0 | 1 | 2;

export class LanguageModelToolCallPart {
  callId: string;
  name: string;
  input: unknown;
  constructor(callId: string, name: string, input: unknown) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

export class LanguageModelToolResultPart {
  callId: string;
  content: unknown[];
  isError: boolean;
  constructor(callId: string, content: unknown[], isError = false) {
    this.callId = callId;
    this.content = content;
    this.isError = isError;
  }
}

export class LanguageModelDataPart {
  data: Uint8Array;
  mimeType: string;
  audience: number[] | undefined;
  constructor(data: Uint8Array, mimeType: string, audience?: number[]) {
    this.data = data;
    this.mimeType = mimeType;
    this.audience = audience;
  }
  static image(data: Uint8Array, mimeType: string) {
    return new LanguageModelDataPart(data, mimeType);
  }
  static json(value: object, mime = "text/x-json") {
    return new LanguageModelDataPart(
      new TextEncoder().encode(JSON.stringify(value, undefined, "\t")),
      mime,
    );
  }
  static text(value: string, mime = "text/plain") {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mime);
  }
}

export class LanguageModelThinkingPart {
  value: string | string[];
  id?: string;
  metadata?: Record<string, unknown>;
  constructor(value: string | string[], id?: string, metadata?: Record<string, unknown>) {
    this.value = value;
    this.id = id;
    this.metadata = metadata;
  }
}

export class LanguageModelPromptTsxPart {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

class LanguageModelMessage {
  role: LanguageModelChatMessageRole;
  name: string | undefined;
  private _content: unknown[] = [];
  constructor(role: LanguageModelChatMessageRole, content: string | unknown[], name?: string) {
    this.role = role;
    this.content = content;
    this.name = name;
  }
  get content(): unknown[] {
    return this._content;
  }
  set content(value: string | unknown[]) {
    this._content = typeof value === "string" ? [new LanguageModelTextPart(value)] : value;
  }
}

export class LanguageModelChatMessage extends LanguageModelMessage {
  static User(content: string | unknown[], name?: string) {
    return new LanguageModelChatMessage(1, content, name);
  }
  static Assistant(content: string | unknown[], name?: string) {
    return new LanguageModelChatMessage(2, content, name);
  }
}

export class LanguageModelChatMessage2 extends LanguageModelMessage {
  static User(content: string | unknown[], name?: string) {
    return new LanguageModelChatMessage2(1, content, name);
  }
  static Assistant(content: string | unknown[], name?: string) {
    return new LanguageModelChatMessage2(2, content, name);
  }
  get content2(): unknown[] {
    return this.content.map((part) => (part instanceof LanguageModelTextPart ? part.value : part));
  }
  set content2(value: unknown[] | undefined) {
    if (value)
      this.content = value.map((part) =>
        typeof part === "string" ? new LanguageModelTextPart(part) : part,
      );
  }
}

export class LanguageModelError extends Error {
  readonly code: string;
  readonly retryAfter?: number;
  constructor(message?: string, code = "", cause?: Error, retryAfter?: number) {
    super(message, { cause });
    this.name = "LanguageModelError";
    this.code = code;
    if (typeof retryAfter === "number" && retryAfter >= 0) this.retryAfter = retryAfter;
  }
  static NotFound(message?: string) {
    return new LanguageModelError(message, "NotFound");
  }
  static NoPermissions(message?: string) {
    return new LanguageModelError(message, "NoPermissions");
  }
  static Blocked(message?: string) {
    return new LanguageModelError(message, "Blocked");
  }
  static RateLimited(message?: string, retryAfter?: number) {
    return new LanguageModelError(message, "RateLimited", undefined, retryAfter);
  }
}

export class LanguageModelToolResult {
  content: unknown[];
  constructor(content: unknown[]) {
    this.content = content;
  }
}
