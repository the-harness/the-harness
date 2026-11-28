import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vite-plus/test";
import {
  createExtensionHostFixture,
  useFixtureExtensionSecrets,
} from "../helpers/extension-host.ts";

it("delivers actual secret changes to the same extension across workers and releases stopped sessions", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "secret-events-"));
  for (const name of ["secret-owner", "other-extension"]) {
    const directory = join(root, name);
    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        publisher: "audit",
        name,
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: [`onCommand:${name}.secrets`],
      }),
    );
    writeFileSync(
      join(directory, "extension.cjs"),
      `
      const vscode = require("vscode");
      exports.activate = context => {
        const events = [];
        context.subscriptions.push(context.secrets.onDidChange(event => events.push({ ...event })));
        context.subscriptions.push(vscode.commands.registerCommand(${JSON.stringify(`${name}.secrets`)}, async (operation, key, value) => {
          if (operation === "store") await context.secrets.store(key, value);
          if (operation === "delete") await context.secrets.delete(key);
          return { events, value: key ? await context.secrets.get(key) : undefined };
        }));
      };
    `,
    );
  }
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const stopped: string[] = [];
  fixture.scope.run(() =>
    host.hooks.sessionStopped.use((sessionId, next) => {
      stopped.push(sessionId);
      return next();
    }),
  );
  await useFixtureExtensionSecrets(fixture);
  const commands = vi.spyOn(host, "executeCommand");
  const secretNotifications = () =>
    commands.mock.calls.filter(([, command]) => command === "__secrets.onDidChange");
  const off = host.onMainThreadCall(async (_session, _method, _args, requestId) => {
    if (requestId) host.resolveMainCall(requestId, undefined);
  });
  try {
    await host.scanExtensions(root);
    for (const session of ["first", "second"]) {
      await host.startSession(session, [root], { storageRoot: join(root, "storage") });
      await host.executeCommand(session, "secret-owner.secrets", "read");
      await host.executeCommand(session, "other-extension.secrets", "read");
    }
    const stored = await host.executeCommand(
      "first",
      "secret-owner.secrets",
      "store",
      "token:with:colon",
      "synthetic-test-value",
    );
    expect(stored).toEqual({
      events: [{ key: "token:with:colon" }],
      value: "synthetic-test-value",
    });
    expect(
      await host.executeCommand("second", "secret-owner.secrets", "read", "token:with:colon"),
    ).toEqual(stored);
    expect(
      await host.executeCommand("second", "other-extension.secrets", "read", "token:with:colon"),
    ).toEqual({ events: [] });
    await host.executeCommand(
      "second",
      "secret-owner.secrets",
      "store",
      "token:with:colon",
      "synthetic-test-value",
    );
    expect(secretNotifications()).toHaveLength(2);
    await host.executeCommand("first", "secret-owner.secrets", "delete", "token:with:colon");
    expect(
      await host.executeCommand("second", "secret-owner.secrets", "read", "token:with:colon"),
    ).toEqual({ events: [{ key: "token:with:colon" }, { key: "token:with:colon" }] });
    await host.stopSession("second");
    await host.stopSession("second");
    expect(stopped).toEqual(["second"]);
    await host.executeCommand(
      "first",
      "secret-owner.secrets",
      "store",
      "next",
      "synthetic-second-value",
    );
    expect(secretNotifications().filter(([, , , key]) => key === "next")).toEqual([
      ["first", "__secrets.onDidChange", "audit.secret-owner", "next"],
    ]);
  } finally {
    await fixture.dispose("first", "second");
    off();
    commands.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
