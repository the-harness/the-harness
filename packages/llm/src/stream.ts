import {
  AssistantMessage,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  type ContentBlock,
} from "./message.ts";
import type { LlmChunk } from "./types.ts";

export function mergeStreamChunk(
  message: AssistantMessage | undefined,
  chunk: LlmChunk,
): AssistantMessage | undefined {
  if (chunk.type === "finish") {
    return message;
  }
  const base = message ?? AssistantMessage.create({ content: [] });
  const blocks: ContentBlock[] = [...base.content];
  const last = blocks[blocks.length - 1];

  switch (chunk.type) {
    case "text_delta":
      if (last instanceof TextBlock) {
        blocks[blocks.length - 1] = TextBlock.create({ text: last.text + chunk.delta });
      } else {
        blocks.push(TextBlock.create({ text: chunk.delta }));
      }
      break;
    case "thinking_delta":
      if (last instanceof ThinkingBlock) {
        blocks[blocks.length - 1] = ThinkingBlock.create({
          thinking: last.thinking + chunk.delta,
        });
      } else {
        blocks.push(ThinkingBlock.create({ thinking: chunk.delta }));
      }
      break;
    case "tool_call_start":
      blocks.push(ToolCallBlock.create({ id: chunk.id, name: chunk.name, arguments: "" }));
      break;
    case "tool_call_delta": {
      const idx = blocks.findLastIndex(
        (b): b is ToolCallBlock => b instanceof ToolCallBlock && b.id === chunk.id,
      );
      if (idx !== -1) {
        const target = blocks[idx] as ToolCallBlock;
        blocks[idx] = ToolCallBlock.create({
          id: target.id,
          name: target.name,
          arguments: target.arguments + chunk.delta,
        });
      }
      break;
    }
    case "tool_call_end": {
      const idx = blocks.findLastIndex(
        (b): b is ToolCallBlock => b instanceof ToolCallBlock && b.id === chunk.id,
      );
      if (idx !== -1) {
        blocks[idx] = ToolCallBlock.create({
          id: chunk.id,
          name: chunk.name,
          arguments: chunk.arguments,
        });
      }
      break;
    }
  }

  return AssistantMessage.create({
    id: base.id,
    meta: base.meta,
    content: blocks,
  });
}
