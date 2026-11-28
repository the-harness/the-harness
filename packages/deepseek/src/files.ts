import { createHash, randomUUID } from "node:crypto";
import { AuthService } from "@harness/auth";
import { optionalInject } from "@harness/di";
import {
  FileService,
  type FileUploadRequest,
  type RemoteFileHandle,
  type WaitReadyOptions,
} from "@harness/files";
import { DEEPSEEK_DEFAULT_BASE_URL, deepseekMessagesRoot } from "./catalog.ts";

export const DEEPSEEK_FILES_BETA = "files-api-2025-04-14";
export const DEEPSEEK_DEFAULT_FILE_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
export const DEEPSEEK_DEFAULT_FILE_REFRESH_MARGIN_SECONDS = 60 * 60;

export type DeepSeekFilePurpose = "user_data" | "text_recognition" | "rich_layout_recognition";

export interface DeepSeekFileServiceOptions {
  readonly baseUrl?: string;
  readonly defaultExpiresInSeconds?: number;
  readonly refreshMarginSeconds?: number;
  readonly quotaCleanupBatch?: number;
  readonly fetch?: typeof fetch;
}

function encodeMultipartUpload(
  boundary: string,
  input: {
    readonly data: Uint8Array;
    readonly mimeType: string;
    readonly filename: string;
    readonly purpose?: string;
    readonly expiresInSeconds?: number;
  },
): Uint8Array {
  const encoder = new TextEncoder();
  const safeFilename = input.filename
    .replaceAll('"', "%22")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  const lines: string[] = [];

  if (input.purpose !== undefined) {
    lines.push(
      `--${boundary}`,
      'Content-Disposition: form-data; name="purpose"',
      "",
      input.purpose,
    );
  }
  if (input.expiresInSeconds !== undefined) {
    lines.push(
      `--${boundary}`,
      'Content-Disposition: form-data; name="expires_after[anchor]"',
      "",
      "created_at",
      `--${boundary}`,
      'Content-Disposition: form-data; name="expires_after[seconds]"',
      "",
      String(input.expiresInSeconds),
    );
  }
  lines.push(
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${safeFilename}"`,
    `Content-Type: ${input.mimeType}`,
    "",
    "",
  );

  const head = encoder.encode(lines.join("\r\n"));
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + input.data.byteLength + tail.byteLength);
  body.set(head);
  body.set(input.data, head.byteLength);
  body.set(tail, head.byteLength + input.data.byteLength);
  return body;
}

function isQuotaError(status: number, detail: string): boolean {
  return status >= 400 && /(?:quota|storage|stored files|file count|too many files)/iu.test(detail);
}

export class DeepSeekFileService extends FileService {
  readonly options: DeepSeekFileServiceOptions;

  protected readonly auth = optionalInject(AuthService);
  protected readonly cache = new Map<string, RemoteFileHandle>();
  protected readonly inflight = new Map<string, Promise<RemoteFileHandle>>();

  constructor(options: DeepSeekFileServiceOptions = {}) {
    super();
    this.options = options;
  }

  invalidate(fileId: string): void {
    for (const [key, handle] of this.cache) {
      if (handle.fileId === fileId) {
        this.cache.delete(key);
      }
    }
  }

  override async upload(
    request: FileUploadRequest,
    waitOptions?: WaitReadyOptions,
  ): Promise<RemoteFileHandle> {
    const root = deepseekMessagesRoot(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const url = `${root}/files`;
    const authResult = await this.auth?.authorize({
      url,
      method: "POST",
      signal: request.signal,
    });
    const purpose = request.purpose ?? "user_data";
    const expiresInSeconds =
      request.expiresInSeconds ??
      this.options.defaultExpiresInSeconds ??
      DEEPSEEK_DEFAULT_FILE_EXPIRY_SECONDS;
    const refreshMarginMs =
      (this.options.refreshMarginSeconds ?? DEEPSEEK_DEFAULT_FILE_REFRESH_MARGIN_SECONDS) * 1_000;

    const hash = createHash("sha256")
      .update(root)
      .update("\0")
      .update(authResult?.identityKey ?? "")
      .update("\0")
      .update(purpose)
      .update("\0")
      .update(request.mimeType)
      .update("\0")
      .update(request.data)
      .digest("hex");

    const cached = this.cache.get(hash);
    if (
      cached !== undefined &&
      (cached.expiresAt === undefined || cached.expiresAt - Date.now() > refreshMarginMs)
    ) {
      return cached;
    }

    const existing = this.inflight.get(hash);
    if (existing !== undefined) {
      return existing;
    }

    const uploadPromise = this.performUpload(
      root,
      authResult?.headers ?? {},
      request,
      purpose,
      expiresInSeconds,
      waitOptions,
    )
      .then((handle) => {
        this.cache.set(hash, handle);
        return handle;
      })
      .finally(() => {
        this.inflight.delete(hash);
      });

    this.inflight.set(hash, uploadPromise);
    return uploadPromise;
  }

  protected async performUpload(
    root: string,
    authHeaders: Readonly<Record<string, string>>,
    request: FileUploadRequest,
    purpose: string,
    expiresInSeconds: number,
    waitOptions?: WaitReadyOptions,
  ): Promise<RemoteFileHandle> {
    const attempt = async (): Promise<RemoteFileHandle> => {
      const boundary = `----harness-deepseek-${randomUUID()}`;
      const body = encodeMultipartUpload(boundary, {
        data: request.data,
        mimeType: request.mimeType,
        filename: request.filename,
        purpose,
        expiresInSeconds,
      });
      const fetchFn = this.options.fetch ?? globalThis.fetch;
      const response = await fetchFn(`${root}/files`, {
        method: "POST",
        redirect: "error",
        headers: {
          ...authHeaders,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": DEEPSEEK_FILES_BETA,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: body as BodyInit,
        signal: request.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        if (isQuotaError(response.status, text)) {
          await this.reclaimOldestFiles(root, authHeaders, request.signal);
          return this.singleUpload(root, authHeaders, request, purpose, expiresInSeconds);
        }
        throw new Error(`DeepSeek Files API upload failed (HTTP ${response.status}): ${text}`);
      }
      const data = (await response.json()) as Record<string, unknown>;
      return this.parseHandle(data, request.mimeType, purpose, expiresInSeconds);
    };

    const handle = await attempt();
    return this.waitUntilReady(handle, waitOptions, request.signal);
  }

  protected async singleUpload(
    root: string,
    authHeaders: Readonly<Record<string, string>>,
    request: FileUploadRequest,
    purpose: string,
    expiresInSeconds: number,
  ): Promise<RemoteFileHandle> {
    const boundary = `----harness-deepseek-${randomUUID()}`;
    const body = encodeMultipartUpload(boundary, {
      data: request.data,
      mimeType: request.mimeType,
      filename: request.filename,
      purpose,
      expiresInSeconds,
    });
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(`${root}/files`, {
      method: "POST",
      redirect: "error",
      headers: {
        ...authHeaders,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": DEEPSEEK_FILES_BETA,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: body as BodyInit,
      signal: request.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DeepSeek Files API upload failed (HTTP ${response.status}): ${text}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    return this.parseHandle(data, request.mimeType, purpose, expiresInSeconds);
  }

  protected async reclaimOldestFiles(
    root: string,
    authHeaders: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(`${root}/files?limit=100`, {
      method: "GET",
      redirect: "error",
      headers: {
        ...authHeaders,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": DEEPSEEK_FILES_BETA,
      },
      signal,
    });
    if (!response.ok) return;
    const json = (await response.json()) as { data?: Array<{ id?: string; created_at?: string }> };
    if (!Array.isArray(json.data)) return;

    const batchSize = this.options.quotaCleanupBatch ?? 20;
    const sorted = json.data
      .filter((item): item is { id: string; created_at?: string } => typeof item.id === "string")
      .toSorted((a, b) => {
        const ta = a.created_at ? Date.parse(a.created_at) : 0;
        const tb = b.created_at ? Date.parse(b.created_at) : 0;
        return ta - tb;
      })
      .slice(0, batchSize);

    for (const item of sorted) {
      await this.delete(item.id, signal).catch(() => {});
    }
  }

  override async get(fileId: string, signal?: AbortSignal): Promise<RemoteFileHandle> {
    const root = deepseekMessagesRoot(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const url = `${root}/files/${encodeURIComponent(fileId)}`;
    const authResult = await this.auth?.authorize({ url, method: "GET", signal });
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      headers: {
        ...authResult?.headers,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": DEEPSEEK_FILES_BETA,
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek Files API get failed with HTTP ${response.status}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    return this.parseHandle(data, "application/octet-stream");
  }

  override async delete(fileId: string, signal?: AbortSignal): Promise<void> {
    this.invalidate(fileId);
    const root = deepseekMessagesRoot(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const url = `${root}/files/${encodeURIComponent(fileId)}`;
    const authResult = await this.auth?.authorize({ url, method: "DELETE", signal });
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: "DELETE",
      redirect: "error",
      headers: {
        ...authResult?.headers,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": DEEPSEEK_FILES_BETA,
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek Files API delete failed with HTTP ${response.status}`);
    }
  }

  protected parseHandle(
    raw: Record<string, unknown>,
    fallbackMimeType: string,
    purpose?: string,
    expiresInSeconds?: number,
  ): RemoteFileHandle {
    const fileId = typeof raw["id"] === "string" ? raw["id"] : "";
    if (!fileId) {
      throw new Error("DeepSeek Files API returned an invalid file object without id");
    }
    const mimeType = typeof raw["mime_type"] === "string" ? raw["mime_type"] : fallbackMimeType;
    const bytes = typeof raw["size_bytes"] === "number" ? raw["size_bytes"] : undefined;
    const createdAtMs =
      typeof raw["created_at"] === "string" ? Date.parse(raw["created_at"]) : Date.now();
    const expiresAt =
      expiresInSeconds !== undefined && !Number.isNaN(createdAtMs)
        ? createdAtMs + expiresInSeconds * 1_000
        : undefined;
    return {
      fileId,
      mimeType,
      bytes,
      purpose,
      status: "ready",
      expiresAt,
    };
  }
}
