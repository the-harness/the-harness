import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

let harness: HarnessModules;
let di: typeof import("../../packages/di/src/index.ts");
let auth: typeof import("../../packages/auth/src/index.ts");
let files: typeof import("../../packages/files/src/index.ts");

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, auth, files] = await Promise.all([
    harness.load<typeof di>("/packages/di/src/index.ts"),
    harness.load<typeof auth>("/packages/auth/src/index.ts"),
    harness.load<typeof files>("/packages/files/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

const upload = {
  data: new Uint8Array([1]),
  filename: "notes.txt",
  mimeType: "text/plain",
};

function sendFile(response: ServerResponse, status: "processing" | "ready"): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: "file-1", status }));
}

async function createFileServer(onPoll: (response: ServerResponse) => void) {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method!);
    request.resume();
    if (request.method === "POST") {
      request.once("end", () => sendFile(response, "processing"));
    } else {
      onPoll(response);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/files`;
  const scope = di.createRootScope();
  scope.provideAll([auth.NoAuthService]);
  const filesService = scope.run(() => new files.HttpFileService({ url }));
  return {
    methods,
    filesService,
    async close() {
      scope.dispose();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

it("times out before polling when the first poll would start after the deadline", async () => {
  const backend = await createFileServer((response) => sendFile(response, "ready"));
  try {
    await expect(
      backend.filesService.upload(upload, { pollIntervalMs: 200, timeoutMs: 30 }),
    ).rejects.toThrow("timed out waiting for file 'file-1' to become ready");
    expect(backend.methods).toEqual(["POST"]);
  } finally {
    await backend.close();
  }
});

it("aborts an in-flight readiness poll when its deadline expires", async () => {
  let closed = false;
  const backend = await createFileServer((response) => {
    response.once("close", () => (closed = true));
  });
  try {
    await expect(
      backend.filesService.upload(upload, {
        pollIntervalMs: 1,
        timeoutMs: 500,
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow("timed out waiting for file 'file-1' to become ready");
    expect(backend.methods).toEqual(["POST", "GET"]);
    await expect.poll(() => closed).toBe(true);
  } finally {
    await backend.close();
  }
});

it.each(["upload", "wait"])("cancels a readiness poll when the %s signal aborts", async (owner) => {
  const uploader = new AbortController();
  const waiter = new AbortController();
  let closed = false;
  const backend = await createFileServer((response) => {
    response.once("close", () => (closed = true));
    (owner === "upload" ? uploader : waiter).abort(new Error(`${owner} canceled`));
  });
  try {
    await expect(
      backend.filesService.upload(
        { ...upload, signal: uploader.signal },
        { pollIntervalMs: 1, signal: AbortSignal.any([waiter.signal, AbortSignal.timeout(2_000)]) },
      ),
    ).rejects.toThrow(`${owner} canceled`);
    expect(backend.methods).toEqual(["POST", "GET"]);
    await expect.poll(() => closed).toBe(true);
  } finally {
    await backend.close();
  }
});
