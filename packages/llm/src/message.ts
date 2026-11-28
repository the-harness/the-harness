import { ExtensibleFields, ExtensibleVariants, variant } from "@harness/variants";

export abstract class ContentBlock extends ExtensibleVariants {}

@variant("core:llm:text")
export class TextBlock extends ContentBlock {
  declare readonly text: string;
}

@variant("core:llm:thinking")
export class ThinkingBlock extends ContentBlock {
  declare readonly thinking: string;
  declare readonly signature?: string;
  declare readonly redacted?: boolean;
}

export abstract class MediaBlock extends ContentBlock {
  declare readonly mimeType: string;
  declare readonly data?: string;
  declare readonly url?: string;
  declare readonly fileId?: string;
  declare readonly filename?: string;
}

@variant("core:llm:image")
export class ImageBlock extends MediaBlock {
  declare readonly width?: number;
  declare readonly height?: number;
  declare readonly detail?: "auto" | "low" | "high" | "original";
}

@variant("core:llm:video")
export class VideoBlock extends MediaBlock {
  declare readonly width?: number;
  declare readonly height?: number;
  declare readonly durationMs?: number;
}

@variant("core:llm:audio")
export class AudioBlock extends MediaBlock {
  declare readonly durationMs?: number;
}

@variant("core:llm:document")
export class DocumentBlock extends MediaBlock {
  declare readonly title?: string;
  declare readonly pageCount?: number;
  declare readonly purpose?: string;
}

@variant("core:llm:tool-call")
export class ToolCallBlock extends ContentBlock {
  declare readonly id: string;
  declare readonly name: string;
  declare readonly arguments: string;
  declare readonly thoughtSignature?: string;
}

export class MessageMeta extends ExtensibleFields {}

export abstract class Message extends ExtensibleVariants<{
  readonly id?: string;
  readonly meta?: MessageMeta;
}> {
  readonly id: string = crypto.randomUUID();
  readonly meta: MessageMeta = new MessageMeta();
}

export abstract class ContentMessage extends Message {
  declare readonly content: readonly ContentBlock[];
}

@variant("core:llm:system")
export class SystemMessage extends ContentMessage {
  declare readonly sectionId?: string;
}

@variant("core:llm:developer")
export class DeveloperMessage extends ContentMessage {}

@variant("core:llm:user")
export class UserMessage extends ContentMessage {}

@variant("core:llm:assistant")
export class AssistantMessage extends ContentMessage {
  declare readonly provider: string;
  declare readonly model: string;
  declare readonly replayState?: unknown;
}

@variant("core:llm:tool")
export class ToolResultMessage extends ContentMessage {
  declare readonly toolCallId: string;
  declare readonly toolName: string;
  declare readonly isError?: boolean;
}

export function extractText(content: readonly ContentBlock[]): string {
  let text = "";
  for (const block of content) {
    if (block instanceof TextBlock) {
      text += block.text;
    }
  }
  return text;
}
