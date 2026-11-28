import { readFile, stat } from "node:fs/promises";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { ImageBlock, ImageModality, LlmService } from "@harness/llm";
import { ModelSelectionService } from "@harness/model-selection";
import { ToolCallService } from "@harness/tool-call";
import type { CodexToolsOptions } from "./index.ts";
import { viewImageParameters } from "./parameters.ts";

const VIEW_IMAGE_DESCRIPTION =
  "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectImageMimeType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const header = bytes.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function supportsImageInput(llm: LlmService, provider: string, model: string): boolean {
  const info = llm.models.find(
    (candidate) => candidate.provider === provider && candidate.id === model,
  );
  return info === undefined
    ? true
    : info.inputModalities.some((modality) => modality instanceof ImageModality);
}

export function useViewImageTool(options: CodexToolsOptions = {}): void {
  if (options.viewImage === false) return;
  const toolCall = inject(ToolCallService);
  const cwdService = inject(CwdService);
  const llm = inject(LlmService);
  const modelSelection = inject(ModelSelectionService);

  toolCall.useTool({
    name: "view_image",
    description: VIEW_IMAGE_DESCRIPTION,
    parameters: viewImageParameters,
    async execute({ path }, { signal }) {
      const { provider, model } = modelSelection.current;
      if (!supportsImageInput(llm, provider, model)) {
        throw new Error("view_image is not allowed because you do not support image inputs");
      }
      signal.throwIfAborted();
      const absolutePath = cwdService.resolve(path);
      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch (error) {
        throw new Error(`unable to locate image at \`${path}\`: ${formatError(error)}`);
      }
      if (!fileStat.isFile()) {
        throw new Error(`image path \`${path}\` is not a file`);
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(absolutePath);
      } catch (error) {
        throw new Error(`unable to read image at \`${path}\`: ${formatError(error)}`);
      }
      signal.throwIfAborted();
      const mimeType = detectImageMimeType(bytes);
      if (mimeType === undefined) {
        throw new Error("unable to process image: invalid or unsupported image data");
      }
      return [
        ImageBlock.create({ mimeType, data: bytes.toString("base64"), detail: "high" }),
      ];
    },
  });
}
