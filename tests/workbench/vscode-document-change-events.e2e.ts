import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

test("VS Code extensions receive FileEditorView deltas and undo reasons", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "vscode-document-change-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "changes");
  const host = await createExtensionHostFixture();
  const session = "document-changes";
  const stopListening = host.service.onMainThreadCall((_id, _method, _args, request) => {
    host.service.resolveMainCall(request, undefined);
  });
  const moduleUrl = "/tests/vscode-document-change-events.fixture.ts";
  const pending: Promise<unknown>[] = [];
  try {
    await mkdir(extension, { recursive: true });
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({
        publisher: "audit",
        name: "changes",
        version: "1.0.0",
        main: "./index.cjs",
        activationEvents: ["onStartupFinished"],
      }),
    );
    await writeFile(
      join(extension, "index.cjs"),
      String.raw`
const vscode = require("vscode");
exports.activate = (context) => {
  const observed = [];
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      observed.push({
        reason: vscode.TextDocumentChangeReason[event.reason],
        text: event.document.getText(),
        version: event.document.version,
        changes: event.contentChanges.map(({ range, rangeOffset, rangeLength, text }) => ({
          range: [range.start.line, range.start.character, range.end.line, range.end.character],
          rangeOffset, rangeLength, text,
        })),
      });
    }),
    vscode.commands.registerCommand("audit.documentChanges", () => observed),
  );
};
`,
    );
    await host.service.scanExtensions(extensions);
    await page.exposeFunction("emitDocumentChange", (event: unknown) => {
      const result = host.service.executeCommand(session, "__ws.onDidChangeTextDocument", event);
      pending.push(result);
      return result;
    });
    await page.goto("/tests/vscode-empty.fixture.html");
    const initial = await page.evaluate(
      async ({ root, moduleUrl }) => {
        const module = await import(moduleUrl);
        const browser = window as typeof window & {
          emitDocumentChange(event: unknown): Promise<unknown>;
        };
        return module.openDocumentChangeFixture(root, browser.emitDocumentChange);
      },
      { root, moduleUrl },
    );
    await host.service.startSession(session, [root], {
      documents: [initial],
      storageRoot: join(root, "storage"),
    });
    await host.service.activateByEvent(session, "onStartupFinished");
    await page.keyboard.insertText("=");
    await page.evaluate(async (moduleUrl) => {
      const module = await import(moduleUrl);
      await module.applyDocumentChangeEdits();
      await module.reloadDocumentChangeFixture("reloaded\n");
    }, moduleUrl);
    await expect(page.locator(".view-lines")).toContainText("reloaded");
    await expect.poll(() => pending.length).toBe(5);
    await Promise.all(pending);
    const events = await host.service.executeCommand(session, "audit.documentChanges");
    expect(events).toMatchObject([
      {
        text: "<div\r\n  class=\r\n",
        version: 2,
        changes: [{ range: [1, 7, 1, 7], rangeOffset: 13, rangeLength: 0, text: "=" }],
      },
      {
        text: "<main\r\n  \tclass=\r\n",
        version: 3,
        changes: [
          { range: [1, 2, 1, 2], rangeOffset: 8, rangeLength: 0, text: "\t" },
          { range: [0, 1, 0, 4], rangeOffset: 1, rangeLength: 3, text: "main" },
        ],
      },
      { text: "<div\r\n  class=\r\n", reason: "Undo", version: 4 },
      { text: "<main\r\n  \tclass=\r\n", reason: "Redo", version: 5 },
      {
        text: "reloaded\n",
        version: 6,
        changes: [{ range: [0, 0, 2, 0], rangeOffset: 0, rangeLength: 18, text: "reloaded\n" }],
      },
    ]);
  } finally {
    await page
      .evaluate(async (moduleUrl) => {
        const module = await import(moduleUrl);
        module.closeDocumentChangeFixture();
      }, moduleUrl)
      .catch(() => {});
    stopListening();
    await host.dispose(session);
    await rm(root, { recursive: true, force: true });
  }
});
