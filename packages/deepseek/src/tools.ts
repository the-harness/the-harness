import { randomUUID } from "node:crypto";
import { AuthService } from "@harness/auth";
import { optionalInject } from "@harness/di";
import { DEEPSEEK_DEFAULT_BASE_URL, deepseekOrigin } from "./catalog.ts";
import type { DeepSeekFilePurpose } from "./files.ts";

export interface DeepSeekTtsRequest {
  readonly text: string;
  readonly voiceId?: "stella" | "tide" | (string & {});
  readonly format?: "wav" | "pcm";
  readonly filterMarkdown?: boolean;
  readonly signal?: AbortSignal;
}

export interface DeepSeekAsrRequest {
  readonly data: Uint8Array;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly signal?: AbortSignal;
}

export interface DeepSeekAsrResult {
  readonly requestId?: string;
  readonly text: string;
  readonly durationMs?: number;
}

export interface DeepSeekOcrRequest {
  readonly data: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  readonly purpose?: Extract<DeepSeekFilePurpose, "text_recognition" | "rich_layout_recognition">;
  readonly signal?: AbortSignal;
}

export interface DeepSeekOcrPage {
  readonly index: number;
  readonly text: string;
  readonly finishReason?: string;
}

export interface DeepSeekOcrResult {
  readonly id: string;
  readonly pageCount: number;
  readonly pages: readonly DeepSeekOcrPage[];
}

export interface DeepSeekToolsOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

export class DeepSeekTtsService {
  readonly options: DeepSeekToolsOptions;

  protected readonly auth = optionalInject(AuthService);

  constructor(options: DeepSeekToolsOptions = {}) {
    this.options = options;
  }

  async synthesize(request: DeepSeekTtsRequest): Promise<ReadableStream<Uint8Array>> {
    const origin = deepseekOrigin(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const url = `${origin}/v1/tools/tts`;
    const authResult = await this.auth?.authorize({
      url,
      method: "POST",
      signal: request.signal,
    });
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: "POST",
      redirect: "error",
      headers: {
        ...authResult?.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: request.text,
        voice_id: request.voiceId ?? "stella",
        format: request.format ?? "wav",
        ...(request.filterMarkdown !== undefined
          ? { filter_markdown: request.filterMarkdown }
          : {}),
      }),
      signal: request.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`DeepSeek TTS API failed with HTTP ${response.status}`);
    }
    return response.body;
  }
}

export class DeepSeekAsrService {
  readonly options: DeepSeekToolsOptions;

  protected readonly auth = optionalInject(AuthService);

  constructor(options: DeepSeekToolsOptions = {}) {
    this.options = options;
  }

  async transcribe(request: DeepSeekAsrRequest): Promise<DeepSeekAsrResult> {
    const origin = deepseekOrigin(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const url = `${origin}/v1/tools/asr`;
    const authResult = await this.auth?.authorize({
      url,
      method: "POST",
      signal: request.signal,
    });
    const boundary = `----harness-deepseek-asr-${randomUUID()}`;
    const filename = (request.filename ?? "audio.wav").replaceAll('"', "%22");
    const mimeType = request.mimeType ?? "audio/wav";
    const encoder = new TextEncoder();
    const head = encoder.encode(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        `Content-Type: ${mimeType}`,
        "",
        "",
      ].join("\r\n"),
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.byteLength + request.data.byteLength + tail.byteLength);
    body.set(head);
    body.set(request.data, head.byteLength);
    body.set(tail, head.byteLength + request.data.byteLength);

    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: "POST",
      redirect: "error",
      headers: {
        ...authResult?.headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        accept: "application/json",
      },
      body,
      signal: request.signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek ASR API failed with HTTP ${response.status}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    return {
      requestId: typeof data["request_id"] === "string" ? data["request_id"] : undefined,
      text: typeof data["text"] === "string" ? data["text"] : "",
      durationMs: typeof data["duration_ms"] === "number" ? data["duration_ms"] : undefined,
    };
  }
}

export class DeepSeekOcrService {
  readonly options: DeepSeekToolsOptions;

  protected readonly auth = optionalInject(AuthService);

  constructor(options: DeepSeekToolsOptions = {}) {
    this.options = options;
  }

  async recognize(request: DeepSeekOcrRequest): Promise<DeepSeekOcrResult> {
    const origin = deepseekOrigin(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const url = `${origin}/v1/tools/ocr`;
    const authResult = await this.auth?.authorize({
      url,
      method: "POST",
      signal: request.signal,
    });
    const boundary = `----harness-deepseek-ocr-${randomUUID()}`;
    const purpose = request.purpose ?? "rich_layout_recognition";
    const filename = request.filename.replaceAll('"', "%22");
    const encoder = new TextEncoder();
    const head = encoder.encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="purpose"',
        "",
        purpose,
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        `Content-Type: ${request.mimeType}`,
        "",
        "",
      ].join("\r\n"),
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.byteLength + request.data.byteLength + tail.byteLength);
    body.set(head);
    body.set(request.data, head.byteLength);
    body.set(tail, head.byteLength + request.data.byteLength);

    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: "POST",
      redirect: "error",
      headers: {
        ...authResult?.headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        accept: "application/json",
      },
      body,
      signal: request.signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek OCR API failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    const data = JSON.parse(text.trim()) as Record<string, unknown>;
    const rawPages = Array.isArray(data["pages"]) ? data["pages"] : [];
    const pages: DeepSeekOcrPage[] = rawPages
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .map((p, idx) => ({
        index: typeof p["index"] === "number" ? p["index"] : idx,
        text: typeof p["text"] === "string" ? p["text"] : "",
        ...(typeof p["finish_reason"] === "string" ? { finishReason: p["finish_reason"] } : {}),
      }));
    return {
      id: typeof data["id"] === "string" ? data["id"] : "",
      pageCount: typeof data["page_count"] === "number" ? data["page_count"] : pages.length,
      pages,
    };
  }
}
