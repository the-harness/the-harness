import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  CancellationTokenSource,
  Position,
  TextDocumentData,
  Uri,
} from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";
import { createMainThreadLanguages } from "../../packages/vscode-ext-host/src/main-thread/languages.ts";

describe("language provider item ownership across a real worker", () => {
  it("keeps call hierarchy items with their originating provider and releases disposed sessions", async () => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "provider-cache-"));
    const directory = join(root, "extensions/fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        publisher: "regression",
        name: "provider-cache",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:cache.ready"],
      }),
    );
    writeFileSync(
      join(directory, "extension.cjs"),
      String.raw`
      const vscode = require('vscode');
      exports.activate = (context) => {
        const uri = vscode.Uri.file(${JSON.stringify(join(root, "main.ts"))});
        const range = new vscode.Range(0, 0, 0, 2);
        class Item extends vscode.CallHierarchyItem {
          #owner;
          constructor(owner) { super(vscode.SymbolKind.Function, 'same-name', '', uri, range, range); this.#owner = owner; }
          owner() { return this.#owner; }
        }
        const makeProvider = owner => ({
          prepareCallHierarchy(document, position) { return position.character === owner ? new Item(owner) : undefined; },
          provideCallHierarchyIncomingCalls(item) {
            if (item.owner() !== owner) throw new Error('wrong provider received item');
            const caller = new Item(owner); caller.name = 'caller-' + owner;
            return [new vscode.CallHierarchyIncomingCall(caller, [range])];
          },
          provideCallHierarchyOutgoingCalls(item) {
            if (item.owner() !== owner) throw new Error('private item state was lost');
            const callee = new Item(owner); callee.name = 'callee-' + owner;
            return [new vscode.CallHierarchyOutgoingCall(callee, [range])];
          },
        });
        const first = vscode.languages.registerCallHierarchyProvider('typescript', makeProvider(0));
        const second = vscode.languages.registerCallHierarchyProvider('typescript', makeProvider(1));
        context.subscriptions.push(first, second);
        context.subscriptions.push(vscode.commands.registerCommand('cache.ready', () => true));
        context.subscriptions.push(vscode.commands.registerCommand('cache.disposeSecond', () => second.dispose()));
      };
    `,
    );
    const fixture = await createExtensionHostFixture();
    const host = fixture.service;
    const commands = new Set<string>();
    const off = host.onMainThreadCall(async (_session, method, args, requestId) => {
      try {
        let result: unknown;
        if (method === "memento.load") result = {};
        else if (method === "commands.register") commands.add(String(args[0]));
        else if (method === "commands.unregister") commands.delete(String(args[0]));
        else if (method !== "auth.unregisterSession")
          throw new Error(`Unexpected bridge call: ${method}`);
        if (requestId) host.resolveMainCall(requestId, result);
      } catch (error) {
        if (requestId) host.resolveMainCall(requestId, undefined, String(error));
      }
    });
    const uri = Uri.file(join(root, "main.ts"));
    try {
      await host.scanExtensions(join(root, "extensions"));
      await host.startSession("cache", [root], {
        storageRoot: join(root, "host-storage"),
        documents: [
          {
            uri: uri.toJSON(),
            text: "ab",
            version: 1,
            languageId: "typescript",
            isDirty: false,
            eol: 1,
          },
        ],
      });
      await host.executeCommand("cache", "cache.ready");
      const first = await host.executeCommand<unknown[]>(
        "cache",
        "vscode.prepareCallHierarchy",
        uri,
        new Position(0, 0),
      );
      const second = await host.executeCommand<unknown[]>(
        "cache",
        "vscode.prepareCallHierarchy",
        uri,
        new Position(0, 1),
      );
      const incoming = await host.executeCommand<{ from: unknown }[]>(
        "cache",
        "vscode.provideIncomingCalls",
        first[0],
      );
      expect(incoming).toMatchObject([{ from: { name: "caller-0" } }]);
      expect(
        await host.executeCommand("cache", "vscode.provideOutgoingCalls", incoming[0]!.from),
      ).toMatchObject([{ to: { name: "callee-0" } }]);
      expect(
        await host.executeCommand("cache", "vscode.provideIncomingCalls", second[0]),
      ).toMatchObject([{ from: { name: "caller-1" } }]);
      await host.executeCommand("cache", "cache.disposeSecond");
      expect(await host.executeCommand("cache", "vscode.provideIncomingCalls", second[0])).toEqual(
        [],
      );
      expect(
        await host.executeCommand("cache", "vscode.provideIncomingCalls", first[0]),
      ).toMatchObject([{ from: { name: "caller-0" } }]);
    } finally {
      await fixture.dispose("cache");
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves original cyclic completion items and releases their command arguments with the list", async () => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "completion-cache-"));
    const directory = join(root, "extensions/fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        publisher: "regression",
        name: "completion-cache",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:cache.ready"],
      }),
    );
    writeFileSync(
      join(directory, "extension.cjs"),
      String.raw`
      const vscode = require('vscode');
      exports.activate = (context) => {
        class Item extends vscode.CompletionItem {
          #secret = 73;
          constructor() { super('item'); this.self = this; this.command = { command: 'cache.accept', title: 'Accept', arguments: [this] }; }
          read() { return this.#secret; }
        }
        const registration = vscode.languages.registerCompletionItemProvider('typescript', {
          provideCompletionItems() { return new vscode.CompletionList([new Item()]); },
          resolveCompletionItem(item) { item.detail = String(item.read()); return item; },
        });
        context.subscriptions.push(registration);
        context.subscriptions.push(vscode.commands.registerCommand('cache.ready', () => true));
        context.subscriptions.push(vscode.commands.registerCommand('cache.accept', item => item.read()));
        context.subscriptions.push(vscode.commands.registerCommand('cache.dispose', () => registration.dispose()));
      };
    `,
    );
    const fixture = await createExtensionHostFixture();
    const host = fixture.service;
    const commands = new Set<string>();
    let provider: Record<string, (...args: unknown[]) => Promise<unknown>> | undefined;
    const handler = createMainThreadLanguages(
      {
        registerCompletionItemProvider(_selector: unknown, value: NonNullable<typeof provider>) {
          provider = value;
          return {
            dispose() {
              provider = undefined;
            },
          };
        },
      } as never,
      (session, command, args) => host.executeCommand(session, command, ...args),
    );
    const off = host.onMainThreadCall(async (session, method, args, requestId) => {
      try {
        let result: unknown;
        if (method.startsWith("languages.")) handler(session, method, args);
        else if (method === "memento.load") result = {};
        else if (method === "commands.register") commands.add(String(args[0]));
        else if (method === "commands.unregister") commands.delete(String(args[0]));
        else if (method !== "auth.unregisterSession")
          throw new Error(`Unexpected bridge call: ${method}`);
        if (requestId) host.resolveMainCall(requestId, result);
      } catch (error) {
        if (requestId) host.resolveMainCall(requestId, undefined, String(error));
      }
    });
    const token = new CancellationTokenSource();
    try {
      await host.scanExtensions(join(root, "extensions"));
      await host.startSession("completion-cache", [root], {
        storageRoot: join(root, "host-storage"),
      });
      await host.executeCommand("completion-cache", "cache.ready");
      await vi.waitFor(() => expect(provider).toBeDefined());
      const document = new TextDocumentData({
        uri: Uri.file(join(root, "main.ts")).toJSON(),
        text: "item",
        version: 1,
        languageId: "typescript",
        isDirty: false,
        eol: 1,
      });
      const list = (await provider!.provideCompletionItems!(
        document,
        new Position(0, 0),
        token.token,
        { triggerKind: 0 },
      )) as { items: { command: { command: string; arguments: unknown[] } }[]; dispose(): void };
      const item = list.items[0]!;
      expect(await provider!.resolveCompletionItem!(item, token.token)).toMatchObject({
        label: "item",
        detail: "73",
      });
      expect(
        await host.executeCommand(
          "completion-cache",
          item.command.command,
          ...item.command.arguments,
        ),
      ).toBe(73);
      list.dispose();
      await host.executeCommand("completion-cache", "cache.ready");
      expect(await provider!.resolveCompletionItem!(item, token.token)).toBeUndefined();
      expect(
        await host.executeCommand(
          "completion-cache",
          item.command.command,
          ...item.command.arguments,
        ),
      ).toBeUndefined();
      await host.executeCommand("completion-cache", "cache.dispose");
      await vi.waitFor(() => expect(provider).toBeUndefined());
      expect(commands.has(item.command.command)).toBe(false);
    } finally {
      token.dispose();
      await fixture.dispose("completion-cache");
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs matching drop providers and resolves their original edit before disposal", async () => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "drop-provider-"));
    const directory = join(root, "extensions/fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        publisher: "regression",
        name: "drop-provider",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:drop.ready"],
      }),
    );
    writeFileSync(
      join(directory, "extension.cjs"),
      String.raw`
      const vscode = require('vscode');
      exports.activate = context => {
        class Edit extends vscode.DocumentDropEdit {
          #uri;
          constructor(text, uri) { super(text, 'Insert dropped text'); this.#uri = uri; }
          resolve() {
            this.additionalEdit = new vscode.WorkspaceEdit();
            this.additionalEdit.insert(this.#uri, new vscode.Position(0, 0), 'prefix');
            return this;
          }
        }
        const provider = vscode.languages.registerDocumentDropEditProvider('typescript', {
          async provideDocumentDropEdits(document, position, transfer, token) {
            if (position.character !== 1 || token.isCancellationRequested) throw new Error('invalid drop context');
            return new Edit(await transfer.get('text/plain').asString(), document.uri);
          },
          resolveDocumentDropEdit(edit) { return edit.resolve(); },
        }, { dropMimeTypes: ['text/*'] });
        context.subscriptions.push(provider);
        context.subscriptions.push(vscode.commands.registerCommand('drop.ready', () => true));
        context.subscriptions.push(vscode.commands.registerCommand('drop.dispose', () => provider.dispose()));
      };
    `,
    );
    const fixture = await createBuiltinLanguageHost(root);
    const uri = Uri.file(join(root, "main.ts"));
    const request = {
      uri,
      position: new Position(0, 1),
      items: [{ mime: "TEXT/PLAIN", value: "dropped" }],
    };
    try {
      await fixture.host.scanExtensions(join(root, "extensions"));
      await fixture.host.startSession("drop", [root], {
        storageRoot: join(root, "host-storage"),
        documents: [
          {
            uri: uri.toJSON(),
            text: "ab",
            version: 1,
            languageId: "typescript",
            isDirty: false,
            eol: 1,
          },
        ],
      });
      await fixture.host.executeCommand("drop", "drop.ready");
      expect(
        await fixture.host.executeCommand(
          "drop",
          "__languages.executeDocumentDropEditProvider",
          request,
        ),
      ).toMatchObject([
        {
          insertText: "dropped",
          title: "Insert dropped text",
          additionalEdit: {
            entries: [[expect.objectContaining({ path: uri.path }), [{ newText: "prefix" }]]],
          },
        },
      ]);
      expect(
        await fixture.host.executeCommand("drop", "__languages.executeDocumentDropEditProvider", {
          ...request,
          items: [{ mime: "image/png", value: "not-text" }],
        }),
      ).toEqual([]);
      await fixture.host.executeCommand("drop", "drop.dispose");
      expect(
        await fixture.host.executeCommand(
          "drop",
          "__languages.executeDocumentDropEditProvider",
          request,
        ),
      ).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.dispose("drop");
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
