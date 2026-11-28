import { MarkdownString } from "./editing.ts";
import type { Uri } from "./uri.ts";

export const ChatResultFeedbackKind = {
  Unhelpful: 0,
  Helpful: 1,
  0: "Unhelpful",
  1: "Helpful",
} as const;
export type ChatResultFeedbackKind = 0 | 1;
export const ChatInputNotificationSeverity = {
  Info: 0,
  Warning: 1,
  Error: 2,
  0: "Info",
  1: "Warning",
  2: "Error",
} as const;
export type ChatInputNotificationSeverity = 0 | 1 | 2;

class ChatMarkdownValue {
  value: MarkdownString;
  constructor(value: string | MarkdownString) {
    if (typeof value !== "string" && value.isTrusted === true)
      throw new Error(
        "The boolean form of MarkdownString.isTrusted is NOT supported for chat participants.",
      );
    this.value = typeof value === "string" ? new MarkdownString(value) : value;
  }
}
export class ChatResponseMarkdownPart extends ChatMarkdownValue {}
export class ChatResponseWarningPart extends ChatMarkdownValue {}
export class ChatResponseInfoPart extends ChatMarkdownValue {}
export class ChatResponseMarkdownWithVulnerabilitiesPart extends ChatMarkdownValue {
  vulnerabilities: unknown[];
  constructor(value: string | MarkdownString, vulnerabilities: unknown[]) {
    super(value);
    this.vulnerabilities = vulnerabilities;
  }
}
export class ChatResponseFileTreePart {
  value: { name: string; children?: unknown[] }[];
  baseUri: Uri;
  constructor(value: { name: string; children?: unknown[] }[], baseUri: Uri) {
    this.value = value;
    this.baseUri = baseUri;
  }
}
export class ChatResponseAnchorPart {
  value: unknown;
  value2: unknown;
  title?: string;
  constructor(value: unknown, title?: string) {
    this.value = value;
    this.value2 = value;
    this.title = title;
  }
}
export class ChatResponseProgressPart {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}
export class ChatResponseThinkingProgressPart {
  value: string | string[];
  id?: string;
  metadata?: Record<string, unknown>;
  constructor(value: string | string[], id?: string, metadata?: Record<string, unknown>) {
    this.value = value;
    this.id = id;
    this.metadata = metadata;
  }
}
export class ChatResponseReferencePart {
  value: unknown;
  iconPath?: unknown;
  options?: unknown;
  constructor(value: unknown, iconPath?: unknown, options?: unknown) {
    this.value = value;
    this.iconPath = iconPath;
    this.options = options;
  }
}
export class ChatResponseCommandButtonPart {
  value: { title: string; command: string; arguments?: unknown[] };
  constructor(value: { title: string; command: string; arguments?: unknown[] }) {
    this.value = value;
  }
}
export class ChatRequestTurn {
  readonly prompt: string;
  readonly command: string | undefined;
  readonly references: unknown[];
  readonly participant: string;
  readonly toolReferences: unknown[];
  readonly editedFileEvents?: unknown[];
  readonly id?: string;
  readonly modelId?: string;
  constructor(
    prompt: string,
    command: string | undefined,
    references: unknown[],
    participant: string,
    toolReferences: unknown[],
    editedFileEvents?: unknown[],
    id?: string,
    modelId?: string,
  ) {
    this.prompt = prompt;
    this.command = command;
    this.references = references;
    this.participant = participant;
    this.toolReferences = toolReferences;
    this.editedFileEvents = editedFileEvents;
    this.id = id;
    this.modelId = modelId;
  }
}
class ChatResponseTurnValue {
  readonly response: unknown[];
  readonly result: unknown;
  readonly participant: string;
  readonly command?: string;
  constructor(response: unknown[], result: unknown, participant: string, command?: string) {
    this.response = response;
    this.result = result;
    this.participant = participant;
    this.command = command;
  }
}
export class ChatResponseTurn extends ChatResponseTurnValue {}
export class ChatResponseTurn2 extends ChatResponseTurnValue {}
