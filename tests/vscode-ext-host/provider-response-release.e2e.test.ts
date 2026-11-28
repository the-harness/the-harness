import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

it("releases provider results delivered after the host cancels their IPC request", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "provider-response-release-"));
  const workerPath = join(root, "worker.cjs");
  writeFileSync(
    workerPath,
    `
process.on("message", message => {
  if (message.type === "cancel") {
    process.send({
      type: "response", id: message.id, result: [{ label: "discarded" }],
      release: { command: "__lang.releaseCompletion.p-1", listId: 5 },
    });
  } else if (message.type === "release") {
    process.send({
      type: "request", id: 1, method: "fixture.released",
      args: [message.command, message.listId],
    });
  } else if (message.type === "request" && message.method === "executeCommand") {
    process.send({ type: "request", id: 2, method: "fixture.started", args: [] });
  } else if (message.type === "request") {
    process.send({ type: "response", id: message.id });
  }
});
`,
  );
  const fixture = await createExtensionHostFixture();
  const di = await fixture.modules.load<typeof import("../../packages/di/src/index.ts")>(
    "/packages/di/src/index.ts",
  );
  const { ExtensionHostService } = await fixture.modules.load<
    typeof import("../../packages/vscode-ext-host/src/index.ts")
  >("/packages/vscode-ext-host/src/index.ts");
  const scope = fixture.scope.createChild({ id: "delayed-worker" });
  scope.provide(di.createDescriptor(ExtensionHostService, { workerPath }));
  const host = scope.get(ExtensionHostService);
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<unknown[]>();
  const release = host.onMainThreadCall(async (_session, method, args, id) => {
    if (method === "fixture.started") started.resolve();
    if (method === "fixture.released") released.resolve(args);
    host.resolveMainCall(id);
  });
  const session = "provider-response-release";
  const controller = new AbortController();
  try {
    await host.startSession(session, [root]);
    const response = host.executeCommandWithSignal(session, "__list", [], controller.signal);
    const rejected = expect(response).rejects.toThrow("consumer canceled");
    await started.promise;
    controller.abort(new Error("consumer canceled"));
    await rejected;
    await expect(released.promise).resolves.toEqual(["__lang.releaseCompletion.p-1", 5]);
  } finally {
    release();
    await host.stopSession(session);
    scope.dispose();
    await fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
