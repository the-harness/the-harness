import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const source = String.raw`
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  const uri = vscode.Uri.parse("fixture:/definitions");
  const kind = vscode.SymbolKind.Function;
  const symbol = (name, start, end) => ({
    name,
    kind,
    containerName: "",
    location: new vscode.Location(uri, new vscode.Range(0, start, 0, end)),
  });
  let started = false;
  let canceled = false;
  let resolved = false;
  subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    provideWorkspaceSymbols(query, token) {
      if (query === "slow") {
        started = true;
        return new Promise(resolve => {
          token.onCancellationRequested(() => {
            canceled = true;
            resolve([symbol("Stale", 0, 1)]);
          });
        });
      }
      if (query !== "") return [];
      return [
        symbol("Zeta", 0, 1),
        { ...symbol("Alpha", 1, 5), tags: [vscode.SymbolTag.Deprecated] },
        symbol("Lazy", 0, 1),
      ];
    },
  }));
  const second = vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query) {
      if (query !== "") return null;
      return [
        symbol("Alpha", 2, 3),
        symbol("Alpha", 5, 7),
        { name: "Lazy", kind, location: new vscode.Location(uri, undefined) },
        { name: "", kind, location: new vscode.Location(uri, undefined) },
      ];
    },
    resolveWorkspaceSymbol(symbol) {
      resolved = true;
      return symbol;
    },
  });
  subscriptions.push(second);
  subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query) {
      if (query === "") throw new Error("Workspace symbol provider failed");
    },
  }));
  subscriptions.push(vscode.commands.registerCommand("symbols.query", async () => {
    const items = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "");
    return items.map(item => ({
      name: item.name,
      start: item.location.range?.start.character ?? null,
      tags: item.tags ?? [],
      typed: item instanceof vscode.SymbolInformation &&
        item.location instanceof vscode.Location &&
        (!item.location.range || item.location.range instanceof vscode.Range),
      uri: item.location.uri.toString(),
    }));
  }));
  subscriptions.push(vscode.commands.registerCommand("symbols.state", () => ({
    started, canceled, resolved,
  })));
  subscriptions.push(vscode.commands.registerCommand("symbols.dispose", () => second.dispose()));
};
`;

it("queries registered workspace symbols through a real extension worker", async () => {
  const artifacts = join(process.cwd(), "temp/artifacts");
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "workspace-symbol-query-"));
  const extension = join(root, "extensions/symbols");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "regression",
      name: "workspace-symbols",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:symbols.query"],
    }),
  );
  writeFileSync(join(extension, "extension.cjs"), source);

  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const off = host.onMainThreadCall(async (_sessionId, _method, _args, requestId) => {
    host.resolveMainCall(requestId, undefined);
  });
  const session = "workspace-symbol-query";
  const abort = new AbortController();
  const query = () => host.executeCommand(session, "symbols.query");
  const state = () => host.executeCommand(session, "symbols.state");
  const result = (name: string, start: number | null, tags: number[] = []) => ({
    name,
    start,
    tags,
    typed: true,
    uri: "fixture:/definitions",
  });
  try {
    await host.scanExtensions(join(root, "extensions"));
    await host.startSession(session, [root], { storageRoot: join(root, "storage") });
    expect(await query()).toEqual([
      result("Alpha", 1, [1]),
      result("Alpha", 5),
      result("Lazy", null),
      result("Lazy", 0),
      result("Zeta", 0),
    ]);
    await expect(
      host.executeCommand(session, "vscode.executeWorkspaceSymbolProvider", null),
    ).rejects.toThrow("Workspace symbol query must be a string");

    const pending = host
      .executeCommandWithSignal(
        session,
        "vscode.executeWorkspaceSymbolProvider",
        ["slow"],
        abort.signal,
      )
      .catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await state()).toMatchObject({ started: true }));
    abort.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    await vi.waitFor(async () =>
      expect(await state()).toEqual({ started: true, canceled: true, resolved: false }),
    );

    await host.executeCommand(session, "symbols.dispose");
    expect(await query()).toEqual([result("Alpha", 1, [1]), result("Lazy", 0), result("Zeta", 0)]);
  } finally {
    abort.abort();
    await fixture.dispose(session);
    off();
    rmSync(root, { recursive: true, force: true });
  }
});
