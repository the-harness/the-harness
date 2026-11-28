import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  CancellationTokenSource,
  Position,
  Range,
  TextDocumentData,
  Uri,
} from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { createMainThreadLanguages } from "../../packages/vscode-ext-host/src/main-thread/languages.ts";

type Provider = Record<string, (...args: unknown[]) => Promise<unknown>>;
const extensionSource = String.raw`
const vscode = require('vscode');
exports.activate = (context) => {
  const seen = [];
  const lensChanged = new vscode.EventEmitter();
  const resource = vscode.Uri.parse('vscode-remote://ssh-remote+dev/project/main.ts?view=1#source');
  const range = new vscode.Range(0, 0, 0, 5);
  const check = (name, document, token, extra) => {
    if (document !== vscode.workspace.textDocuments.find(doc => doc.uri.toString() === document.uri.toString())) throw new Error('Document identity was lost');
    if (!(document.lineAt(0).range instanceof vscode.Range)) throw new Error('TextLine range was not revived');
    const subscription = token.onCancellationRequested(() => {});
    subscription.dispose();
    seen.push({ name, text: document.getText(), line: document.lineAt(1).text, version: document.version,
      languageId: document.languageId, offset: document.offsetAt(new vscode.Position(1, 2)),
      uri: document.uri.toString(), cancelled: token.isCancellationRequested, extra });
  };
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider([{ language: 'typescript', scheme: 'vscode-remote' }], {
    provideCompletionItems(document, position, token, completionContext) {
      check('completion', document, token, { character: position.translate(0, 1).character, context: completionContext });
      const item = new vscode.CompletionItem({ label: 'hello', detail: '()', description: 'fixture' }, vscode.CompletionItemKind.Function);
      item.insertText = new vscode.SnippetString('hello($1)');
      item.range = { inserting: range, replacing: new vscode.Range(0, 0, 0, 6) };
      item.documentation = new vscode.MarkdownString('**hello**');
      item.documentation.isTrusted = { enabledCommands: ['fixture.run'] };
      item.documentation.baseUri = resource;
      item.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(1, 0), 'import hello;')];
      item.command = { title: 'Run', command: 'fixture.run', arguments: [resource] };
      item.fixtureData = 42;
      return new vscode.CompletionList([item], true);
    },
    resolveCompletionItem(item, token) {
      if (typeof token.onCancellationRequested !== 'function' || item.fixtureData !== 42) throw new Error('Resolve context was lost');
      item.detail = 'resolved';
      return item;
    },
  }, '.'));
  context.subscriptions.push(vscode.languages.registerHoverProvider('typescript', {
    provideHover(document, position, token) { check('hover', document, token, position.isEqual(new vscode.Position(0, 2))); return new vscode.Hover(new vscode.MarkdownString('hover'), range); },
  }));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider('typescript', {
    provideDefinition(document, position, token) { check('definition', document, token); return new vscode.Location(resource, range); },
  }));
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider('typescript', {
    provideInlineCompletionItems(document, position, inlineContext, token) { check('inline', document, token, { triggerKind: inlineContext.triggerKind, contains: inlineContext.selectedCompletionInfo.range.contains(position) }); return { items: [{ insertText: new vscode.SnippetString('hello($1)'), range }] }; },
  }));
  context.subscriptions.push(vscode.languages.registerReferenceProvider('typescript', {
    provideReferences(document, position, referenceContext, token) { check('reference', document, token, referenceContext); return [new vscode.Location(resource, range)]; },
  }));
  const hintTooltips = new WeakMap();
  context.subscriptions.push(vscode.languages.registerInlayHintsProvider('typescript', {
    provideInlayHints() {
      const hint = new vscode.InlayHint(new vscode.Position(0, 2), ': string');
      hintTooltips.set(hint, new vscode.MarkdownString('Resolved inlay hint'));
      return [hint];
    },
    resolveInlayHint(hint) {
      const tooltip = hintTooltips.get(hint);
      if (!tooltip || !(hint instanceof vscode.InlayHint)) throw new Error('Inlay hint identity was lost');
      return Object.assign(new vscode.InlayHint(hint.position, hint.label), { tooltip });
    },
  }));
  context.subscriptions.push(vscode.languages.registerRenameProvider('typescript', {
    prepareRename(document, position, token) { check('prepareRename', document, token); return { range, placeholder: 'hello' }; },
    provideRenameEdits(document, position, name, token) {
      check('rename', document, token, name);
      const edit = new vscode.WorkspaceEdit();
      if (name === 'unsupported') edit.createFile(resource);
      else edit.replace(resource, range, name);
      return edit;
    },
  }));
  const actionEdits = new WeakMap();
  const mixedUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'mixed.txt');
  context.subscriptions.push(vscode.commands.registerCommand('fixture.mixedDone', async () =>
    new TextDecoder().decode(await vscode.workspace.fs.readFile(mixedUri)),
  ));
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider('typescript', {
    provideCodeActions(document, actionRange, actionContext, token) {
      check('codeAction', document, token, { contains: actionRange.contains(new vscode.Position(0, 1)), only: vscode.CodeActionKind.QuickFix.contains(actionContext.only), triggerKind: actionContext.triggerKind });
      const action = new vscode.CodeAction('Fix', vscode.CodeActionKind.QuickFix);
      const mixed = new vscode.CodeAction('Create and edit', vscode.CodeActionKind.QuickFix);
      action.privateState = action;
      actionEdits.set(action, 'fixed');
      actionEdits.set(mixed, 'mixed');
      return [action, { title: 'Run', command: 'fixture.run', arguments: ['command argument'] }, mixed];
    },
    resolveCodeAction(action) {
      const replacement = actionEdits.get(action);
      if (!replacement) throw new Error('Code action identity was lost');
      const resolved = new vscode.CodeAction(action.title, action.kind);
      const edit = new vscode.WorkspaceEdit();
      if (replacement === 'mixed') {
        edit.createFile(mixedUri);
        edit.insert(mixedUri, new vscode.Position(0, 0), 'mixed edit applied');
        resolved.command = { title: 'Read result', command: 'fixture.mixedDone' };
      } else {
        edit.replace(resource, range, replacement);
      }
      resolved.edit = edit;
      return resolved;
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
  context.subscriptions.push(vscode.languages.registerColorProvider('typescript', {
    provideDocumentColors(document, token) { check('color', document, token); return [new vscode.ColorInformation(range, new vscode.Color(1, 0, 0, 1))]; },
    provideColorPresentations(color, colorContext, token) { check('colorPresentation', colorContext.document, token, colorContext.range.contains(new vscode.Position(0, 1))); return [{ label: 'red', textEdit: vscode.TextEdit.replace(colorContext.range, '#f00') }]; },
  }));
  context.subscriptions.push(vscode.languages.registerSignatureHelpProvider('typescript', {
    provideSignatureHelp(document, position, token, signatureContext) { check('signature', document, token, signatureContext); return { signatures: [{ label: 'hello(value)', documentation: new vscode.MarkdownString('signature'), parameters: [{ label: [6, 11] }] }], activeSignature: 0, activeParameter: 0 }; },
  }, { triggerCharacters: ['('], retriggerCharacters: [','] }));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider('typescript', {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(document, token) { check('lens', document, token); return [new vscode.CodeLens(range)]; },
    resolveCodeLens(lens) { lens.command = { title: 'Resolved lens', command: 'fixture.run' }; return lens; },
  }));
  context.subscriptions.push(vscode.commands.registerCommand('language.ready', () => true));
  context.subscriptions.push(vscode.commands.registerCommand('language.match', () => {
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === resource.toString());
    const match = selector => vscode.languages.match(selector, document);
    const base = resource.with({ path: '/project', query: '', fragment: '' });
    const relative = new vscode.RelativePattern(base, '[!x]ain.ts');
    return {
      included: match({ scheme: resource.scheme, pattern: '**/[!x]ain.ts' }),
      excluded: match({ scheme: resource.scheme, pattern: '**/[!m]ain.ts' }),
      relative: match(['*', { pattern: relative }]),
      outsideBase: match({ pattern: new vscode.RelativePattern(vscode.Uri.joinPath(base, 'sub'), '**/*.ts') }),
      emptyScheme: match({ scheme: '', language: 'typescript' }),
    };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('language.seen', () => seen));
  context.subscriptions.push(vscode.commands.registerCommand('language.changed', () => lensChanged.fire()));
  let first; let second;
  context.subscriptions.push(vscode.commands.registerCommand('language.diagnostics', () => {
    first = vscode.languages.createDiagnosticCollection('same-name');
    second = vscode.languages.createDiagnosticCollection('same-name');
    const one = new vscode.Diagnostic(range, 'first', vscode.DiagnosticSeverity.Warning);
    one.code = { value: 17, target: resource };
    one.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(resource, range), 'related')];
    first.set([[resource, [one]], [resource, [new vscode.Diagnostic(range, 'second')]]]);
    second.set(resource, [new vscode.Diagnostic(range, 'third')]);
    const visited = [];
    first.forEach((uri, diagnostics, owner) => visited.push([uri.toString(), diagnostics.length, owner === first]));
    return { count: first.get(resource).length, has: first.has(resource), visited, entries: [...first].length, total: vscode.languages.getDiagnostics(resource).length };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('language.clearDiagnostics', () => {
    first.set(resource, undefined); first.dispose();
    return vscode.languages.getDiagnostics(resource).map(diagnostic => diagnostic.message);
  }));
};
`;

async function startFixture() {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "language-bridge-"));
  const directory = join(root, "extensions/language");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      publisher: "regression",
      name: "language",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:language.ready"],
    }),
  );
  writeFileSync(join(directory, "extension.cjs"), extensionSource);
  const providers = new Map<string, Provider>();
  const diagnostics: {
    name: string;
    updates: { uri: string; diagnostics: unknown }[];
    cleared: number;
    disposed: boolean;
  }[] = [];
  const methods = [
    "CompletionItem",
    "Hover",
    "Definition",
    "InlineCompletionItem",
    "Reference",
    "InlayHints",
    "Rename",
    "CodeActions",
    "Color",
    "SignatureHelp",
    "CodeLens",
  ];
  const languageService = {
    ...Object.fromEntries(
      methods.map((kind) => [
        `register${kind}Provider`,
        (_selector: unknown, provider: Provider) => {
          providers.set(kind, provider);
          return { dispose: () => providers.delete(kind) };
        },
      ]),
    ),
    createDiagnosticCollection(name: string) {
      const record = {
        name,
        updates: [] as { uri: string; diagnostics: unknown }[],
        cleared: 0,
        disposed: false,
      };
      diagnostics.push(record);
      return {
        set(uri: Uri, values: unknown) {
          record.updates.push({ uri: uri.toString(), diagnostics: values });
        },
        clear() {
          record.cleared++;
        },
        dispose() {
          record.disposed = true;
        },
      };
    },
  };
  const hostFixture = await createExtensionHostFixture();
  const host = hostFixture.service;
  const handler = createMainThreadLanguages(languageService as never, (session, command, args) =>
    host.executeCommand(session, command, ...args),
  );
  const errors: string[] = [];
  const off = host.onMainThreadCall(async (session, method, args, requestId) => {
    try {
      if (method.startsWith("languages.")) handler(session, method, args);
      let result: boolean | undefined;
      if (method === "workspace.applyEdit") {
        const [[resource, [edit]]] = args[0] as [
          [{ scheme: string; path: string }, [{ newText: string }]],
        ];
        const path = Uri.from(resource).fsPath;
        if (readFileSync(path, "utf8") !== "") throw new Error("Expected a newly created file");
        writeFileSync(path, edit.newText);
        result = true;
      }
      if (requestId) host.resolveMainCall(requestId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      if (requestId) host.resolveMainCall(requestId, undefined, message);
    }
  });
  const uri = Uri.parse("vscode-remote://ssh-remote+dev/project/main.ts?view=1#source");
  const document = new TextDocumentData({
    uri: uri.toJSON(),
    text: "hello()\nworld",
    languageId: "typescript",
    version: 7,
    isDirty: true,
    eol: 1,
  });
  try {
    await host.scanExtensions(join(root, "extensions"));
    await host.startSession("language", [root], { documents: [document.toJSON()] });
    await host.executeCommand("language", "language.ready");
    await vi.waitFor(() => expect(providers.size).toBe(methods.length));
  } catch (error) {
    await hostFixture.dispose("language");
    off();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    host,
    providers,
    diagnostics,
    errors,
    document,
    call(kind: string, method: string, ...args: unknown[]) {
      return providers.get(kind)![method]!(...args);
    },
    async dispose() {
      await hostFixture.dispose("language");
      off();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("language providers through the real extension worker and main thread", () => {
  it("uses VS Code document selector glob syntax and scores", async () => {
    const fixture = await startFixture();
    try {
      expect(await fixture.host.executeCommand("language", "language.match")).toEqual({
        included: 10,
        excluded: 0,
        relative: 10,
        outsideBase: 0,
        emptyScheme: 10,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("preserves document identity, provider arguments, rich results and resolve calls", async () => {
    const fixture = await startFixture();
    const token = new CancellationTokenSource();
    const position = new Position(0, 2);
    const range = new Range(0, 0, 0, 5);
    try {
      const completion = (await fixture.call(
        "CompletionItem",
        "provideCompletionItems",
        fixture.document,
        position,
        token.token,
        { triggerKind: 1, triggerCharacter: "." },
      )) as { items: unknown[]; isIncomplete: boolean };
      expect(completion).toMatchObject({
        isIncomplete: true,
        items: [
          {
            label: { label: "hello", detail: "()", description: "fixture" },
            kind: 2,
            insertText: { value: "hello($1)" },
            documentation: {
              value: "**hello**",
              isTrusted: { enabledCommands: ["fixture.run"] },
              baseUri: { scheme: "vscode-remote", query: "view=1", fragment: "source" },
            },
            additionalTextEdits: [{ newText: "import hello;" }],
            command: { command: expect.stringContaining("__lang.acceptCompletion.") },
          },
        ],
      });
      expect(
        await fixture.call(
          "CompletionItem",
          "resolveCompletionItem",
          completion.items[0],
          token.token,
        ),
      ).toMatchObject({ detail: "resolved" });
      expect(
        await fixture.call(
          "Definition",
          "provideDefinition",
          fixture.document,
          position,
          token.token,
        ),
      ).toMatchObject({
        uri: {
          scheme: "vscode-remote",
          authority: "ssh-remote+dev",
          query: "view=1",
          fragment: "source",
        },
        range,
      });
      await fixture.call(
        "InlineCompletionItem",
        "provideInlineCompletionItems",
        fixture.document,
        position,
        { triggerKind: 0, selectedCompletionInfo: { range, text: "hello" } },
        token.token,
      );
      await fixture.call(
        "Reference",
        "provideReferences",
        fixture.document,
        position,
        { includeDeclaration: true },
        token.token,
      );
      expect(
        await fixture.call("Rename", "prepareRename", fixture.document, position, token.token),
      ).toMatchObject({ placeholder: "hello", range });
      expect(
        await fixture.call(
          "Rename",
          "provideRenameEdits",
          fixture.document,
          position,
          "renamed",
          token.token,
        ),
      ).toMatchObject({
        entries: [[{ scheme: "vscode-remote", query: "view=1" }, [{ newText: "renamed", range }]]],
      });
      await expect(
        fixture.call(
          "Rename",
          "provideRenameEdits",
          fixture.document,
          position,
          "unsupported",
          token.token,
        ),
      ).rejects.toThrow("file, snippet and notebook operations are not supported");
      const actions = (await fixture.call(
        "CodeActions",
        "provideCodeActions",
        fixture.document,
        range,
        { diagnostics: [], only: { value: "quickfix" }, triggerKind: 2 },
        token.token,
      )) as unknown[] & { dispose(): void };
      expect(actions[0]).toMatchObject({ title: "Fix", kind: { value: "quickfix" } });
      expect(actions[0]).not.toHaveProperty("privateState");
      expect(actions[1]).toMatchObject({
        title: "Run",
        command: "fixture.run",
        arguments: ["command argument"],
      });
      const resolveAction = (action: unknown) =>
        fixture.call("CodeActions", "resolveCodeAction", action, token.token);
      const resolved = await resolveAction(actions[0]);
      const resolvedEdit = {
        edit: { entries: [[{ scheme: "vscode-remote" }, [{ newText: "fixed" }]]] },
      };
      expect(resolved).toMatchObject(resolvedEdit);
      expect(await resolveAction(resolved)).toMatchObject(resolvedEdit);
      const mixed = (await resolveAction(actions[2])) as { applyWorkspaceEdit(): Promise<unknown> };
      await expect(mixed.applyWorkspaceEdit()).resolves.toBe("mixed edit applied");
      actions.dispose();
      expect(await resolveAction(actions[0])).toBeUndefined();
      await expect(mixed.applyWorkspaceEdit()).rejects.toThrow(
        "This code action is no longer available",
      );
      await fixture.call(
        "Color",
        "provideColorPresentations",
        { red: 1, green: 0, blue: 0, alpha: 1 },
        { document: fixture.document, range },
        token.token,
      );
      await fixture.call(
        "SignatureHelp",
        "provideSignatureHelp",
        fixture.document,
        position,
        token.token,
        { triggerKind: 2, triggerCharacter: "(", isRetrigger: true },
      );
      const lenses = (await fixture.call(
        "CodeLens",
        "provideCodeLenses",
        fixture.document,
        token.token,
      )) as unknown[];
      expect(
        await fixture.call("CodeLens", "resolveCodeLens", lenses[0], token.token),
      ).toMatchObject({
        command: {
          command: expect.stringContaining("__lang.acceptCodeLens."),
          title: "Resolved lens",
        },
      });
      let changes = 0;
      const subscribe = fixture.providers.get("CodeLens")!.onDidChangeCodeLenses as unknown as (
        listener: () => void,
      ) => { dispose(): void };
      const subscription = subscribe(() => changes++);
      await fixture.host.executeCommand("language", "language.changed");
      await vi.waitFor(() => expect(changes).toBe(1));
      subscription.dispose();
      token.cancel();
      await fixture.call("Hover", "provideHover", fixture.document, position, token.token);
      const seen = await fixture.host.executeCommand<
        {
          name: string;
          text: string;
          offset: number;
          version: number;
          extra: unknown;
          cancelled: boolean;
        }[]
      >("language", "language.seen");
      expect(
        seen.every(
          (entry) => entry.text === "hello()\nworld" && entry.version === 7 && entry.offset === 10,
        ),
      ).toBe(true);
      expect(seen).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "completion",
            extra: { character: 3, context: { triggerKind: 1, triggerCharacter: "." } },
          }),
          expect.objectContaining({ name: "inline", extra: { triggerKind: 0, contains: true } }),
          expect.objectContaining({ name: "reference", extra: { includeDeclaration: true } }),
          expect.objectContaining({
            name: "codeAction",
            extra: { contains: true, only: true, triggerKind: 2 },
          }),
          expect.objectContaining({ name: "colorPresentation", extra: true }),
          expect.objectContaining({ name: "hover", cancelled: true, extra: true }),
        ]),
      );
      expect(fixture.errors).toEqual([]);
    } finally {
      token.dispose();
      await fixture.dispose();
    }
  });

  it("resolves the original inlay hint until the list is disposed", async () => {
    const fixture = await startFixture();
    const token = new CancellationTokenSource();
    try {
      const hints = (await fixture.call(
        "InlayHints",
        "provideInlayHints",
        fixture.document,
        new Range(0, 0, 0, 5),
        token.token,
      )) as unknown[] & { dispose(): void };
      const hint = hints[0];
      const resolved = await fixture.call("InlayHints", "resolveInlayHint", hint, token.token);
      expect(resolved).toMatchObject({
        label: ": string",
        tooltip: { value: "Resolved inlay hint" },
      });
      expect(await fixture.call("InlayHints", "resolveInlayHint", resolved, token.token)).toEqual(
        resolved,
      );
      hints.dispose();
      expect(
        await fixture.call("InlayHints", "resolveInlayHint", hint, token.token),
      ).toBeUndefined();
    } finally {
      token.dispose();
      await fixture.dispose();
    }
  });

  it("keeps same-name diagnostic collections independent and supports batch reads and removal", async () => {
    const fixture = await startFixture();
    try {
      expect(await fixture.host.executeCommand("language", "language.diagnostics")).toEqual({
        count: 2,
        has: true,
        visited: [[fixture.document.uri.toString(), 2, true]],
        entries: 1,
        total: 3,
      });
      await vi.waitFor(() => expect(fixture.diagnostics).toHaveLength(2));
      expect(fixture.diagnostics[0]!.updates[0]).toMatchObject({
        uri: fixture.document.uri.toString(),
        diagnostics: [
          {
            message: "first",
            severity: 1,
            code: { value: 17, target: { scheme: "vscode-remote" } },
            relatedInformation: [{ message: "related" }],
          },
          { message: "second" },
        ],
      });
      expect(await fixture.host.executeCommand("language", "language.clearDiagnostics")).toEqual([
        "third",
      ]);
      await vi.waitFor(() => expect(fixture.diagnostics[0]!.disposed).toBe(true));
      expect(fixture.diagnostics[0]!.updates.at(-1)?.diagnostics).toBeUndefined();
      expect(fixture.diagnostics[1]!.disposed).toBe(false);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
