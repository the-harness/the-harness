import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type AuthModule = typeof import("../../packages/auth/src/index.ts");
type FilesModule = typeof import("../../packages/files/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let auth: AuthModule;
let files: FilesModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, auth, files] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<AuthModule>("/packages/auth/src/index.ts"),
    harness.load<FilesModule>("/packages/files/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly form?: FormData;
}

function requestRecorder(responses: Array<() => Response>) {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    const recorded: RecordedRequest = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.method === "POST" ? { form: await request.clone().formData() } : {}),
    };
    requests.push(recorded);
    const response = responses[requests.length - 1];
    if (response === undefined) throw new Error("unexpected extra request");
    return response();
  }) as typeof globalThis.fetch;
  return { requests, fetch };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFileService(fetchFn: typeof globalThis.fetch, options: { auth?: boolean } = {}) {
  const scope = di.createRootScope();
  scope.provideAll([
    options.auth === false
      ? auth.NoAuthService
      : [
          auth.AuthService,
          di.createDescriptor(auth.ApiKeyAuthService, {
            apiKey: "test-key",
            headerName: "X-Api-Key",
          }),
        ],
  ]);
  return {
    scope,
    service: scope.run(
      () =>
        new files.HttpFileService({
          url: "https://files.test/v1/files/",
          defaultPurpose: "assistants",
          fetch: fetchFn,
        }),
    ),
  };
}

describe("http file service", () => {
  it("uploads a multipart file, polls processing state and returns the ready handle", async () => {
    const { requests, fetch } = requestRecorder([
      () => jsonResponse({ file: { id: "file-1", status: "processing", mime_type: "text/plain" } }),
      () =>
        jsonResponse({
          file: {
            id: "file-1",
            status: "ready",
            bytes: 5,
            uri: "files://file-1",
            mime_type: "text/plain",
            purpose: "assistants",
          },
        }),
    ]);
    const opened = createFileService(fetch);
    try {
      const handle = await opened.service.upload(
        {
          data: new TextEncoder().encode("hello"),
          filename: "notes.txt",
          mimeType: "text/plain",
          purpose: "assistants",
          expiresInSeconds: 3600,
        },
        { pollIntervalMs: 1, timeoutMs: 5_000 },
      );
      expect(handle).toMatchObject({
        fileId: "file-1",
        fileUri: "files://file-1",
        mimeType: "text/plain",
        bytes: 5,
        purpose: "assistants",
        status: "ready",
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        url: "https://files.test/v1/files/",
        method: "POST",
      });
      expect(requests[0]!.headers.get("X-Api-Key")).toBe("test-key");
      const form = requests[0]!.form!;
      expect(form.get("purpose")).toBe("assistants");
      expect(form.get("expires_after[anchor]")).toBe("created_at");
      expect(form.get("expires_after[seconds]")).toBe("3600");
      const file = form.get("file") as File;
      expect(file.name).toBe("notes.txt");
      expect(file.type).toBe("text/plain");
      expect(await file.text()).toBe("hello");

      expect(requests[1]).toMatchObject({
        url: "https://files.test/v1/files/file-1",
        method: "GET",
      });
    } finally {
      opened.scope.dispose();
    }
  });

  it("reports upload, processing and HTTP failures without returning a handle", async () => {
    const failedUpload = requestRecorder([() => jsonResponse({}, 500)]);
    const first = createFileService(failedUpload.fetch);
    try {
      await expect(
        first.service.upload({
          data: new Uint8Array([1]),
          filename: "a.bin",
          mimeType: "application/octet-stream",
        }),
      ).rejects.toThrow("file upload failed with HTTP 500");
    } finally {
      first.scope.dispose();
    }

    const failedProcessing = requestRecorder([
      () => jsonResponse({ file: { id: "file-2", status: "processing" } }),
      () => jsonResponse({ file: { id: "file-2", status: "failed" } }),
    ]);
    const second = createFileService(failedProcessing.fetch);
    try {
      await expect(
        second.service.upload(
          { data: new Uint8Array([1]), filename: "a.bin", mimeType: "application/octet-stream" },
          { pollIntervalMs: 1, timeoutMs: 5_000 },
        ),
      ).rejects.toThrow("file processing failed for 'file-2'");
    } finally {
      second.scope.dispose();
    }

    const failedImmediately = requestRecorder([
      () => jsonResponse({ file: { id: "file-3", status: "failed" } }),
    ]);
    const third = createFileService(failedImmediately.fetch);
    try {
      await expect(
        third.service.upload({
          data: new Uint8Array([1]),
          filename: "a.bin",
          mimeType: "application/octet-stream",
        }),
      ).rejects.toThrow("file upload failed for 'file-3'");
    } finally {
      third.scope.dispose();
    }
  });

  it("times out a processing file and honours an already aborted signal", async () => {
    const { fetch } = requestRecorder([
      () => jsonResponse({ file: { id: "slow", status: "processing" } }),
      () => jsonResponse({ file: { id: "slow", status: "processing" } }),
    ]);
    const opened = createFileService(fetch);
    try {
      await expect(
        opened.service.upload(
          { data: new Uint8Array([1]), filename: "a.bin", mimeType: "application/octet-stream" },
          { pollIntervalMs: 1, timeoutMs: 0 },
        ),
      ).rejects.toThrow("timed out waiting for file 'slow' to become ready");

      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(opened.service.get("slow", controller.signal)).rejects.toThrow("cancelled");
    } finally {
      opened.scope.dispose();
    }
  });

  it("encodes file ids for get and delete and surfaces HTTP errors", async () => {
    const { requests, fetch } = requestRecorder([
      () => jsonResponse({ id: "a/b c", status: "ready", size_bytes: 3 }),
      () => new Response("no", { status: 404 }),
    ]);
    const opened = createFileService(fetch, { auth: false });
    try {
      const handle = await opened.service.get("a/b c");
      expect(handle).toMatchObject({ fileId: "a/b c", bytes: 3, status: "ready" });
      expect(requests[0]).toMatchObject({
        url: "https://files.test/v1/files/a%2Fb%20c",
        method: "GET",
      });

      await expect(opened.service.delete("missing")).rejects.toThrow(
        "file delete failed with HTTP 404",
      );
      expect(requests[1]).toMatchObject({
        url: "https://files.test/v1/files/missing",
        method: "DELETE",
      });
    } finally {
      opened.scope.dispose();
    }
  });
});
