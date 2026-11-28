import { AuthService } from "@harness/auth";
import { inject } from "@harness/di";

export interface FileUploadRequest {
  readonly data: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  readonly purpose?: string;
  readonly expiresInSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface RemoteFileHandle {
  readonly fileId: string;
  readonly fileUri?: string;
  readonly mimeType: string;
  readonly bytes?: number;
  readonly purpose?: string;
  readonly status: "processing" | "ready" | "failed";
  readonly expiresAt?: number;
}

export interface WaitReadyOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export abstract class FileService {
  abstract upload(
    request: FileUploadRequest,
    waitOptions?: WaitReadyOptions,
  ): Promise<RemoteFileHandle>;
  abstract get(fileId: string, signal?: AbortSignal): Promise<RemoteFileHandle>;
  abstract delete(fileId: string, signal?: AbortSignal): Promise<void>;

  protected async waitUntilReady(
    initial: RemoteFileHandle,
    waitOptions?: WaitReadyOptions,
    uploadSignal?: AbortSignal,
  ): Promise<RemoteFileHandle> {
    if (initial.status === "failed") {
      throw new Error(`file upload failed for '${initial.fileId}'`);
    }
    if (initial.status === "ready") {
      return initial;
    }
    const timeoutError = new Error(
      `timed out waiting for file '${initial.fileId}' to become ready`,
    );
    const timeoutMs = waitOptions?.timeoutMs ?? Infinity;
    if (timeoutMs <= 0) throw timeoutError;
    const pollIntervalMs = waitOptions?.pollIntervalMs ?? 1_000;
    const deadline = performance.now() + timeoutMs;
    const deadlineController = new AbortController();
    const signal = AbortSignal.any(
      [uploadSignal, waitOptions?.signal, deadlineController.signal].filter(
        (source) => source !== undefined,
      ),
    );
    signal.throwIfAborted();
    const checkActive = () => {
      if (performance.now() >= deadline) deadlineController.abort(timeoutError);
      signal.throwIfAborted();
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        deadlineController.abort(timeoutError);
      } else {
        timer = setTimeout(armDeadline, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
      }
    };
    const poll = async () => {
      let current = initial;
      while (current.status === "processing") {
        await sleep(pollIntervalMs, signal);
        checkActive();
        current = await this.get(current.fileId, signal);
        checkActive();
        if (current.status === "failed") {
          throw new Error(`file processing failed for '${current.fileId}'`);
        }
      }
      return current;
    };

    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (Number.isFinite(deadline)) armDeadline();
      return await Promise.race([poll(), aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface HttpFileServiceOptions {
  readonly url: string;
  readonly defaultPurpose?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

export class HttpFileService extends FileService {
  readonly options: HttpFileServiceOptions;

  protected readonly auth = inject(AuthService);

  constructor(options: HttpFileServiceOptions) {
    super();
    this.options = options;
  }

  override async upload(
    request: FileUploadRequest,
    waitOptions?: WaitReadyOptions,
  ): Promise<RemoteFileHandle> {
    const authResult = await this.auth.authorize({
      url: this.options.url,
      method: "POST",
      signal: request.signal,
    });
    const form = new FormData();
    const purpose = request.purpose ?? this.options.defaultPurpose;
    if (purpose !== undefined) {
      form.append("purpose", purpose);
    }
    if (request.expiresInSeconds !== undefined) {
      form.append("expires_after[anchor]", "created_at");
      form.append("expires_after[seconds]", String(request.expiresInSeconds));
    }
    const blob = new Blob([request.data as BlobPart], { type: request.mimeType });
    form.append("file", blob, request.filename);

    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(this.options.url, {
      method: "POST",
      headers: {
        ...this.options.headers,
        ...authResult.headers,
      },
      body: form,
      signal: request.signal,
    });
    if (!response.ok) {
      throw new Error(`file upload failed with HTTP ${response.status}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const handle = this.parseFileHandle(data, request.mimeType, purpose);
    return this.waitUntilReady(handle, waitOptions, request.signal);
  }

  override async get(fileId: string, signal?: AbortSignal): Promise<RemoteFileHandle> {
    const targetUrl = `${this.options.url.replace(/\/+$/, "")}/${encodeURIComponent(fileId)}`;
    const authResult = await this.auth.authorize({
      url: targetUrl,
      method: "GET",
      signal,
    });
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(targetUrl, {
      method: "GET",
      headers: {
        ...this.options.headers,
        ...authResult.headers,
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`file get failed with HTTP ${response.status}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    return this.parseFileHandle(data, "application/octet-stream");
  }

  override async delete(fileId: string, signal?: AbortSignal): Promise<void> {
    const targetUrl = `${this.options.url.replace(/\/+$/, "")}/${encodeURIComponent(fileId)}`;
    const authResult = await this.auth.authorize({
      url: targetUrl,
      method: "DELETE",
      signal,
    });
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(targetUrl, {
      method: "DELETE",
      headers: {
        ...this.options.headers,
        ...authResult.headers,
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`file delete failed with HTTP ${response.status}`);
    }
  }

  protected parseFileHandle(
    raw: Record<string, unknown>,
    fallbackMimeType: string,
    fallbackPurpose?: string,
  ): RemoteFileHandle {
    const fileObj =
      typeof raw["file"] === "object" && raw["file"] !== null
        ? (raw["file"] as Record<string, unknown>)
        : raw;
    const fileId =
      typeof fileObj["id"] === "string"
        ? fileObj["id"]
        : typeof fileObj["name"] === "string"
          ? fileObj["name"]
          : "";
    const fileUri = typeof fileObj["uri"] === "string" ? fileObj["uri"] : undefined;
    const mimeType =
      typeof fileObj["mime_type"] === "string"
        ? fileObj["mime_type"]
        : typeof fileObj["mimeType"] === "string"
          ? fileObj["mimeType"]
          : fallbackMimeType;
    const bytes =
      typeof fileObj["bytes"] === "number"
        ? fileObj["bytes"]
        : typeof fileObj["size_bytes"] === "number"
          ? fileObj["size_bytes"]
          : undefined;
    const purpose = typeof fileObj["purpose"] === "string" ? fileObj["purpose"] : fallbackPurpose;
    const rawState = String(fileObj["status"] ?? fileObj["state"] ?? "ready").toLowerCase();
    const status: RemoteFileHandle["status"] =
      rawState === "processing"
        ? "processing"
        : rawState === "failed" || rawState === "error"
          ? "failed"
          : "ready";
    const expiresAt =
      typeof fileObj["expires_at"] === "number" ? fileObj["expires_at"] * 1_000 : undefined;

    return {
      fileId,
      fileUri,
      mimeType,
      bytes,
      purpose,
      status,
      expiresAt,
    };
  }
}
