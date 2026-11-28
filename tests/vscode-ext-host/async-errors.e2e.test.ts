import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const source = `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  const reports = [];
  const reported = Promise.withResolvers();
  const originalError = console.error;
  console.error = (message, error) => {
    reports.push(error instanceof Error ? error.message : String(error ?? message));
    if (reports.includes("Floating rejection")) reported.resolve();
  };
  const channel = vscode.window.createOutputChannel("Fixture", { log: true });
  subscriptions.push(channel, new vscode.Disposable(() => { console.error = originalError; }));
  subscriptions.push(vscode.commands.registerCommand("fixture.rpcError", () => {
    throw new Error("RPC command error");
  }));
  subscriptions.push(vscode.commands.registerCommand("fixture.triggerErrors", async () => {
    channel.dispose();
    setImmediate(() => channel.info("log from an asynchronous close callback"));
    setTimeout(() => {
      const later = Promise.reject(new Error("Handled later"));
      setTimeout(() => { void later.catch(() => undefined); }, 20);
      void Promise.reject(new vscode.CancellationError());
      void Promise.reject(new Error("Floating rejection"));
    }, 30);
    await reported.promise;
    return reports;
  }));
};
`;

const peerSource = `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  subscriptions.push(vscode.commands.registerCommand("fixture.peer", () => "peer stayed active"));
};
`;

it("reports stray extension errors without stopping a peer or treating cancellations as failures", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-async-errors-"));
  try {
    const installed = join(root, "extensions");
    for (const [name, activationEvent, body] of [
      ["errors", "onCommand:fixture.triggerErrors", source],
      ["peer", "onCommand:fixture.peer", peerSource],
    ] as const) {
      const directory = join(installed, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name,
          publisher: "fixture",
          version: "1.0.0",
          main: "./index.cjs",
          activationEvents: [activationEvent],
        }),
      );
      writeFileSync(join(directory, "index.cjs"), body);
    }

    const { service, dispose } = await createExtensionHostFixture();
    const session = "async-errors";
    const off = service.onMainThreadCall((_session, _method, _args, request) => {
      service.resolveMainCall(request);
    });
    try {
      await service.scanExtensions(installed);
      await service.startSession(session, [root], { storageRoot: join(root, "storage") });
      assert.equal(await service.executeCommand(session, "fixture.peer"), "peer stayed active");
      await service.activateByEvent(session, "onCommand:fixture.triggerErrors");
      await assert.rejects(service.executeCommand(session, "fixture.rpcError"), {
        message: "RPC command error",
      });
      assert.deepEqual(await service.executeCommand(session, "fixture.triggerErrors"), [
        "Channel has been closed",
        "Floating rejection",
      ]);
      assert.equal(await service.executeCommand(session, "fixture.peer"), "peer stayed active");
    } finally {
      try {
        await dispose(session);
      } finally {
        off();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
