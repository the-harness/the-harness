import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vite-plus/test";
import { Position, Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const extension = `
const vscode = require("vscode");
exports.activate = (context) => {
  const range = new vscode.Range(0, 0, 0, 5);
  let prepares = 0;
  let reads = 0;
  const originals = new WeakSet();
  function item(name, uri) {
    const value = new vscode.TypeHierarchyItem(vscode.SymbolKind.Class, name, "detail", uri, range, range);
    value.tags = [vscode.SymbolTag.Deprecated];
    originals.add(value);
    return value;
  }
  function expand(original, name) {
    if (!originals.has(original)) throw new Error("Expected the original provider item");
    return [item(name, original.uri)];
  }
  const provider = {
    prepareTypeHierarchy(document, position, token) {
      if (this !== provider || !(position instanceof vscode.Position) ||
          position.character !== 3 || token.isCancellationRequested ||
          document.getText() !== "class Child {}") {
        throw new Error("Unexpected prepare arguments");
      }
      prepares++;
      return [item("Child", document.uri), item("Sibling", document.uri)];
    },
    provideTypeHierarchySupertypes(original) { return expand(original, "Parent"); },
    provideTypeHierarchySubtypes(original) { return expand(original, "Grandchild"); },
  };
  const registration = vscode.languages.registerTypeHierarchyProvider(
    { scheme: "fixture-types", language: "typescript" }, provider,
  );
  context.subscriptions.push(
    registration,
    vscode.languages.registerTypeHierarchyProvider("*", {
      prepareTypeHierarchy() { throw new Error("Called the lower-ranked provider"); },
    }),
    vscode.workspace.registerTextDocumentContentProvider("fixture-types", {
      provideTextDocumentContent() { reads++; return "class Child {}"; },
    }),
    vscode.commands.registerCommand("fixture.localTypes", async () => {
      const uri = vscode.Uri.parse("fixture-types:/types.ts?version=1#symbol");
      const [item] = await vscode.commands.executeCommand("vscode.prepareTypeHierarchy", uri, new vscode.Position(0, 3));
      const [parent] = await vscode.commands.executeCommand("vscode.provideSupertypes", item);
      return {
        name: parent.name,
        hadTypes: item instanceof vscode.TypeHierarchyItem && item.uri instanceof vscode.Uri &&
          item.selectionRange instanceof vscode.Range,
        prepares, reads,
      };
    }),
    vscode.commands.registerCommand("fixture.disposeTypes", () => registration.dispose()),
  );
};
`;

it("keeps type hierarchy items through both command paths and retires them on disposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-type-hierarchy-"));
  const installed = join(root, "extensions");
  const directory = join(installed, "types");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "types",
      publisher: "fixture",
      version: "1.0.0",
      engines: { vscode: "*" },
      activationEvents: ["onCommand:fixture.localTypes"],
      main: "./index.cjs",
    }),
  );
  writeFileSync(join(directory, "index.cjs"), extension);

  const { service, dispose } = await createExtensionHostFixture();
  const session = "type-hierarchy";
  const off = service.onMainThreadCall((_id, method, _args, requestId) => {
    if (requestId)
      service.resolveMainCall(
        requestId,
        method === "workspace.resolveDocumentLanguage" ? "typescript" : undefined,
      );
  });
  try {
    await service.scanExtensions(installed);
    await service.startSession(session, [root], { storageRoot: join(root, "host-storage") });
    await service.activateByEvent(session, "onCommand:fixture.localTypes");
    assert.deepEqual(await service.executeCommand(session, "fixture.localTypes"), {
      name: "Parent",
      hadTypes: true,
      prepares: 1,
      reads: 1,
    });

    const uri = Uri.parse("fixture-types:/types.ts?version=1#symbol");
    type Item = {
      name: string;
      detail: string;
      tags: number[];
      uri: { query: string; fragment: string };
    };
    const roots = (await service.executeCommand(
      session,
      "vscode.prepareTypeHierarchy",
      uri,
      new Position(0, 3),
    )) as Item[];
    assert.deepEqual(
      roots.map(({ name }) => name),
      ["Child", "Sibling"],
    );
    assert.equal(roots[0]!.detail, "detail");
    assert.deepEqual(roots[0]!.tags, [1]);
    assert.equal(roots[0]!.uri.query, "version=1");
    assert.equal(roots[0]!.uri.fragment, "symbol");
    const parents = (await service.executeCommand(
      session,
      "vscode.provideSupertypes",
      roots[1],
    )) as Item[];
    assert.deepEqual(
      parents.map(({ name }) => name),
      ["Parent"],
    );
    const nested = (await service.executeCommand(
      session,
      "vscode.provideSubtypes",
      parents[0],
    )) as Item[];
    assert.deepEqual(
      nested.map(({ name }) => name),
      ["Grandchild"],
    );

    await service.executeCommand(session, "fixture.disposeTypes");
    assert.deepEqual(await service.executeCommand(session, "vscode.provideSubtypes", roots[0]), []);
  } finally {
    off();
    await dispose(session);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
