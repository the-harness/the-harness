import type { ChatStreamEvent } from "@harness/chat-session/types";
import {
  AssistantMessage,
  extractText,
  ImageBlock,
  mergeStreamChunk,
  Message,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
} from "@harness/llm";
import {
  ChatDurationField,
  ChatTimestampField,
  type ActivityItem,
  type SessionMessage,
} from "./types.ts";

const MAX_LIVE_TOOL_OUTPUT_CHARS = 50 * 1024;

// The messages of the active run as its events replay; the step in progress is `draft`.
export class LiveRun {
  readonly messages: Message[] = [];
  readonly outputs = new Map<string, string>();
  draft: AssistantMessage | undefined;

  apply(event: ChatStreamEvent): void {
    if (event.type === "message") {
      const message = Message.deserialize(event.message);
      if (message instanceof AssistantMessage && this.draft) {
        this.messages[this.messages.indexOf(this.draft)] = message;
        this.draft = undefined;
      } else {
        this.messages.push(message);
      }
    } else if (event.type === "chunk") {
      const next = mergeStreamChunk(this.draft, event.chunk)!;
      if (this.draft) this.messages[this.messages.indexOf(this.draft)] = next;
      else this.messages.push(next);
      this.draft = next;
    } else if (event.type === "tool_output") {
      const output = (this.outputs.get(event.id) ?? "") + event.delta;
      this.outputs.set(event.id, output.slice(-MAX_LIVE_TOOL_OUTPUT_CHARS));
    }
  }
}

export function getPendingText(msg: UserMessage): string {
  return extractText(msg.content);
}

export function getMessageImages(message: UserMessage): readonly ImageBlock[] {
  return message.content.filter(
    (block): block is ImageBlock =>
      block instanceof ImageBlock && Boolean(block.fileId || block.data || block.url),
  );
}

export function extractToolTarget(rawArgs: string): string | undefined {
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    if (typeof parsed["path"] === "string") return parsed["path"];
    if (typeof parsed["command"] === "string") return parsed["command"];
  } catch {
    // Partial or non-JSON arguments fall back to omitting target.
  }
  return undefined;
}

// Builds transcript rows; an assistant step that only used tools is merged into the step after it.
// Assistant rows and thoughts are keyed by their position after the prompt, so they keep their
// identity while a streamed step is replaced by its final message and later by the stored one.
export function toTranscript(messages: readonly Message[], live?: LiveRun): SessionMessage[] {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message instanceof ToolResultMessage) results.set(message.toolCallId, message);
  }

  const running = new Set<Message>(live?.messages);
  const rows: SessionMessage[] = [];
  let anchor: string | undefined;
  let replies = 0;
  for (const message of messages) {
    if (message instanceof ToolResultMessage) continue;
    if (message instanceof UserMessage) {
      const images = getMessageImages(message);
      rows.push({
        id: message.id,
        role: "user",
        text: extractText(message.content),
        timestamp: message.meta.get(ChatTimestampField),
        ...(images.length > 0 ? { images } : {}),
      });
      anchor = message.id;
      replies = 0;
      continue;
    }
    if (!(message instanceof AssistantMessage)) {
      rows.push({ id: message.id, role: "assistant", text: "", source: message });
      continue;
    }

    anchor ??= message.id;
    const previous = rows.at(-1);
    const merged =
      previous?.role === "assistant" &&
      !previous.source &&
      !previous.text &&
      Boolean(previous.activities?.length);
    const id = merged ? previous.id : `${anchor}:reply-${replies++}`;
    let thoughts = merged
      ? previous.activities!.filter((item) => item.kind === "thinking").length
      : 0;

    const streaming = live !== undefined && message === live.draft;
    const texts: string[] = [];
    const activities: ActivityItem[] = [];
    for (const [index, block] of message.content.entries()) {
      if (block instanceof TextBlock) {
        texts.push(block.text);
      } else if (block instanceof ThinkingBlock && !block.redacted && block.thinking) {
        activities.push({
          kind: "thinking",
          id: `${id}-think-${thoughts++}`,
          text: block.thinking,
          ...(streaming && index === message.content.length - 1 ? { streaming: true } : {}),
        });
      } else if (block instanceof ToolCallBlock) {
        const target = extractToolTarget(block.arguments);
        const result = results.get(block.id);
        const output = result ? extractText(result.content) : live?.outputs.get(block.id);
        const status = result
          ? result.isError
            ? "error"
            : "ok"
          : running.has(message)
            ? "running"
            : undefined;
        activities.push({
          kind: "tool",
          id: block.id,
          tool: {
            id: block.id,
            name: block.name,
            ...(target !== undefined ? { target } : {}),
            ...(block.name === "bash" && target !== undefined ? { command: target } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(status ? { status } : {}),
          },
        });
      }
    }

    const durationMs = message.meta.get(ChatDurationField);
    if (merged) {
      rows[rows.length - 1] = {
        id,
        role: "assistant",
        text: texts.join("\n\n"),
        activities: [...previous.activities!, ...activities],
        durationMs:
          previous.durationMs !== undefined && durationMs !== undefined
            ? previous.durationMs + durationMs
            : undefined,
      };
    } else {
      rows.push({ id, role: "assistant", text: texts.join("\n\n"), durationMs, activities });
    }
  }

  if (live) {
    const last = rows.at(-1);
    rows[last?.role === "assistant" ? rows.length - 1 : rows.length] = {
      ...(last?.role === "assistant"
        ? last
        : { id: `${anchor ?? "live"}:reply-${replies}`, role: "assistant", text: "" }),
      streaming: true,
    };
  }
  return rows;
}
