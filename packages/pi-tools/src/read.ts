import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import {
  AudioBlock,
  DocumentBlock,
  ImageBlock,
  TextBlock,
  VideoBlock,
  type ContentBlock,
} from "@harness/llm";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const VIDEO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};

const AUDIO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
};

const DOCUMENT_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
};

function readMediaFileBlock(filePath: string, bytes: Buffer): readonly ContentBlock[] | undefined {
  const ext = extname(filePath).toLowerCase();
  const filename = basename(filePath);
  const sizeLabel = formatSize(bytes.byteLength);

  const imageMime = IMAGE_MIME_BY_EXT[ext];
  if (imageMime !== undefined) {
    return [
      TextBlock.create({ text: `Read image file [${imageMime}]` }),
      ImageBlock.create({
        mimeType: imageMime,
        data: bytes.toString("base64"),
        filename,
      }),
    ];
  }

  const videoMime = VIDEO_MIME_BY_EXT[ext];
  if (videoMime !== undefined) {
    return [
      TextBlock.create({ text: `[Video "${filename}" (${videoMime}, ${sizeLabel})]` }),
      VideoBlock.create({
        mimeType: videoMime,
        data: bytes.toString("base64"),
        filename,
      }),
    ];
  }

  const audioMime = AUDIO_MIME_BY_EXT[ext];
  if (audioMime !== undefined) {
    return [
      TextBlock.create({ text: `[Audio "${filename}" (${audioMime}, ${sizeLabel})]` }),
      AudioBlock.create({
        mimeType: audioMime,
        data: bytes.toString("base64"),
        filename,
      }),
    ];
  }

  const docMime = DOCUMENT_MIME_BY_EXT[ext];
  if (docMime !== undefined) {
    return [
      TextBlock.create({ text: `[Document "${filename}" (${docMime}, ${sizeLabel})]` }),
      DocumentBlock.create({
        mimeType: docMime,
        data: bytes.toString("base64"),
        filename,
      }),
    ];
  }

  return undefined;
}

export const readParameters = z.object({
  path: z.string().describe("Path to the file to read (relative or absolute)"),
  offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
  limit: z.number().optional().describe("Maximum number of lines to read"),
});

export function useReadTool(): void {
  const toolCall = inject(ToolCallService);
  const cwdService = inject(CwdService);
  toolCall.useTool(functionTool({
    name: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large text files. When you need the full file, continue with offset until complete.`,
    parameters: readParameters,
    async execute({ path, offset, limit }, { signal }) {
      signal.throwIfAborted();
      const absolutePath = cwdService.resolve(path);
      await access(absolutePath, constants.R_OK);
      signal.throwIfAborted();

      const rawBytes = await readFile(absolutePath);
      signal.throwIfAborted();

      const mediaBlocks = readMediaFileBlock(absolutePath, rawBytes);
      if (mediaBlocks !== undefined) {
        return mediaBlocks;
      }

      const content = rawBytes.toString("utf-8");
      const allLines = content.split("\n");
      const totalFileLines = allLines.length;
      const startLine = offset !== undefined ? Math.max(0, Math.trunc(offset) - 1) : 0;
      const startLineDisplay = startLine + 1;

      if (startLine >= totalFileLines) {
        throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
      }

      const endLine =
        limit !== undefined ? Math.min(startLine + Math.trunc(limit), totalFileLines) : undefined;
      const selected = allLines.slice(startLine, endLine).join("\n");
      const truncation = truncateHead(selected);

      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
        return `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
      }

      if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        const suffix =
          truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
        return `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${suffix}. Use offset=${nextOffset} to continue.]`;
      }

      if (endLine !== undefined && endLine < totalFileLines) {
        const remaining = totalFileLines - endLine;
        return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${endLine + 1} to continue.]`;
      }

      return truncation.content;
    },
  }));
}
