import { AgentLoop } from "@harness/agent-loop";
import { inject } from "@harness/di";
import {
  AudioBlock,
  ContentMessage,
  DocumentBlock,
  ImageBlock,
  MessageMeta,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  VideoBlock,
  type ContentBlock,
  type Message,
} from "@harness/llm";

const EstimatedField = MessageMeta.defineField<number, typeof MessageMeta>(
  "core:context-size:estimated",
);
const MeasuredOutputField = MessageMeta.defineField<number, typeof MessageMeta>(
  "core:context-size:measured-output",
);

const PATCH_SIZE = 14;
const DOWNSAMPLE_RATIO = 3;
const MAX_IMAGE_TOKENS = 1024;
const MIN_PIXELS = 544 * 544;
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO;

function intDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

function ceilDiv(value: number, divisor: number): number {
  return Math.floor((value + divisor - 1) / divisor);
}

function gridTokens(gridHeight: number, gridWidth: number): number {
  return gridHeight * (gridWidth + 1) + 2;
}

function gridCells(paddedLength: number): number {
  return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO);
}

function estimateImageTokens(width?: number, height?: number): number {
  if (
    width === undefined ||
    height === undefined ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return MAX_IMAGE_TOKENS;
  }
  let scaledWidth = width;
  let scaledHeight = height;
  const pixels = scaledWidth * scaledHeight;
  if (pixels < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / pixels);
    scaledWidth = Math.trunc(scaledWidth * scale);
    scaledHeight = Math.trunc(scaledHeight * scale);
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE;
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE;
  const direct = gridTokens(gridCells(paddedHeight), gridCells(paddedWidth));
  if (direct <= MAX_IMAGE_TOKENS) {
    return direct;
  }
  const aspect = scaledHeight / scaledWidth;
  const idealGridWidth = Math.sqrt((MAX_IMAGE_TOKENS - 2) / aspect + 0.25) - 0.5;
  const idealGridHeight = idealGridWidth * aspect;
  if (idealGridWidth < 1) {
    const solvedGridHeight = intDiv(MAX_IMAGE_TOKENS - 2, 2);
    return gridTokens(gridCells(solvedGridHeight * CELL_SIZE), gridCells(CELL_SIZE));
  }
  if (idealGridHeight < 1) {
    const solvedGridWidth = intDiv(MAX_IMAGE_TOKENS - 2, 1) - 1;
    return gridTokens(gridCells(CELL_SIZE), gridCells(solvedGridWidth * CELL_SIZE));
  }
  const solvedGridWidth = Math.trunc(idealGridWidth);
  const solvedGridHeight = Math.trunc(idealGridHeight);
  const scale = Math.min(
    (solvedGridWidth * CELL_SIZE) / scaledWidth,
    (solvedGridHeight * CELL_SIZE) / scaledHeight,
  );
  const bestWidth = Math.trunc((scaledWidth * scale) / PATCH_SIZE) * PATCH_SIZE;
  const bestHeight = Math.trunc((scaledHeight * scale) / PATCH_SIZE) * PATCH_SIZE;
  return Math.min(MAX_IMAGE_TOKENS, gridTokens(gridCells(bestHeight), gridCells(bestWidth)));
}

function estimateBlockTokens(block: ContentBlock): number {
  if (block instanceof TextBlock) {
    return Math.ceil(block.text.length / 4);
  }
  if (block instanceof ThinkingBlock) {
    return Math.ceil(block.thinking.length / 4);
  }
  if (block instanceof ToolCallBlock) {
    return Math.ceil((block.name.length + block.arguments.length) / 4);
  }
  if (block instanceof ImageBlock) {
    return estimateImageTokens(block.width, block.height);
  }
  if (block instanceof VideoBlock) {
    if (block.durationMs !== undefined && block.durationMs > 0) {
      return Math.ceil((block.durationMs / 1_000) * 256);
    }
    return 2_048;
  }
  if (block instanceof AudioBlock) {
    if (block.durationMs !== undefined && block.durationMs > 0) {
      return Math.ceil((block.durationMs / 1_000) * 50);
    }
    return 512;
  }
  if (block instanceof DocumentBlock) {
    if (block.pageCount !== undefined && block.pageCount > 0) {
      return block.pageCount * 1_024;
    }
    return 1_024;
  }
  return 0;
}

export class ContextSizeService {
  estimate(message: Message): number {
    if (!(message instanceof ContentMessage)) {
      return 0;
    }
    let total = 0;
    for (const block of message.content) {
      total += estimateBlockTokens(block);
    }
    return total;
  }

  sizeOf(message: Message): number {
    const measured = message.meta.get(MeasuredOutputField);
    if (measured !== undefined) {
      return measured;
    }
    let estimated = message.meta.get(EstimatedField);
    if (estimated === undefined) {
      estimated = this.estimate(message);
      message.meta.set(EstimatedField, estimated);
    }
    return estimated;
  }
}

export function useContextSize(): void {
  const loop = inject(AgentLoop);

  loop.hooks.handleOutput.use(({ response }, next) => {
    const outputTokens = response.usage?.outputTokens;
    if (outputTokens !== undefined && outputTokens > 0) {
      response.message.meta.set(MeasuredOutputField, outputTokens);
    }
    return next();
  });
}
