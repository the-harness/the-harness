import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const extensionSource = String.raw`
const vscode = require("vscode");

exports.activate = (context) => {
  context.subscriptions.push(vscode.commands.registerCommand("audit.values", async (scenario) => {
    if (scenario === "encoding") {
      const workspace = vscode.workspace;
      const sync = user => vscode.commands.executeCommand("__config.sync", { defaults: {}, user, workspace: {} });
      const explicit = name => ({ encoding: name });
      const scope = vscode.Uri.joinPath(workspace.workspaceFolders[0].uri, "sample.txt");
      await vscode.commands.executeCommand("__ws.onDidOpenTextDocument", {
        uri: scope.toJSON(), languageId: "fixture-legacy", text: "", version: 1, isDirty: false, eol: 1,
      });
      const utf8 = await workspace.encode("é");
      const utf8BOM = await workspace.encode("é", explicit("utf8bom"));
      const utf16 = await workspace.encode("é", explicit("UTF-16BE"));
      const utf16WithoutBOM = Uint8Array.of(65, 0, 66, 0);
      const view = Uint8Array.of(0, 0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0).subarray(1, 6);
      await sync({ "files.encoding": "windows1252", "[fixture-legacy]": { "files.encoding": "utf16le" } });
      const configured = await workspace.encode("€");
      const scoped = await workspace.encode("é", { uri: scope });
      const settings = vscode.Uri.joinPath(workspace.workspaceFolders[0].uri, ".vscode", "settings.json");
      const settingsBytes = await workspace.encode("é", { uri: settings, encoding: "utf16le" });
      const unsupported = await workspace.encode("é", explicit("not-a-fixture-encoding"));
      const decodedConfigured = await workspace.decode(configured);
      const source = "Текст для надёжного определения кодировки.";
      const legacy = await workspace.encode(source, explicit("windows1251"));
      await sync({ "files.autoGuessEncoding": true, "files.candidateGuessEncodings": ["windows1251"] });
      let rejectsBinary = false;
      try { await workspace.decode(Uint8Array.of(0x41, 0, 0, 0x42), explicit("utf8")); }
      catch (error) { rejectsBinary = /binary/.test(error.message); }
      return {
        typed: utf8 instanceof Uint8Array,
        utf8: [...utf8], utf8BOM: [...utf8BOM], utf16: [...utf16],
        decodedUtf16: await workspace.decode(utf16),
        emptyUtf16: [...await workspace.encode("", explicit("utf16le"))],
        decodedView: await workspace.decode(view),
        decodedWithoutBOM: await workspace.decode(utf16WithoutBOM),
        configured: [...configured], decodedConfigured,
        scoped: [...scoped], settingsBytes: [...settingsBytes], unsupported: [...unsupported],
        guessed: await workspace.decode(legacy),
        rejectsBinary,
      };
    }
    if (scenario === "geometry") {
      const position = new vscode.Position(2, 3);
      const range = new vscode.Range(4, 2, 1, 1);
      const selection = new vscode.Selection(4, 2, 1, 1);
      let rejectsNegative = false;
      try { new vscode.Position(-1, 0); } catch { rejectsNegative = true; }
      return {
        rejectsNegative,
        before: position.isBefore(new vscode.Position(3, 0)),
        translation: position.translate({ lineDelta: 1, characterDelta: -2 }),
        samePosition: position.with({}) === position,
        range: { start: range.start, end: range.end, singleLine: range.isSingleLine },
        intersection: range.intersection(new vscode.Range(0, 0, 2, 0)),
        contains: range.contains(position),
        selection: { start: selection.start, end: selection.end, active: selection.active, reversed: selection.isReversed },
      };
    }
    if (scenario === "resources") {
      const remote = vscode.Uri.parse("vscode-remote://ssh-remote+fixture/workspace/file%20name.ts?view=1#L2", true);
      const decoded = vscode.Uri.parse(remote.toString(), true);
      const joined = vscode.Uri.joinPath(remote, "..", "other.ts");
      const edit = new vscode.WorkspaceEdit();
      edit.insert(remote, new vscode.Position(0, 0), "remote");
      edit.insert(vscode.Uri.file(remote.path), new vscode.Position(0, 0), "local");
      const pattern = new vscode.RelativePattern(vscode.Uri.file("/project"), "**/*.ts");
      pattern.base = "/elsewhere";
      const tree = new vscode.TreeItem(remote);
      const labelledTree = new vscode.TreeItem({ label: "match", highlights: [[0, 1]] });
      return {
        remote: { scheme: decoded.scheme, authority: decoded.authority, path: decoded.path, query: decoded.query, fragment: decoded.fragment },
        joined: { path: joined.path, query: joined.query, fragment: joined.fragment, authority: joined.authority },
        file: vscode.Uri.file("/tmp/project#draft/file?.ts").toString(),
        editSize: edit.size,
        remoteText: edit.get(remote).map(item => item.newText),
        hasLocal: edit.has(vscode.Uri.file(remote.path)),
        base: pattern.baseUri.path,
        treeUri: tree.resourceUri.toString(),
        label: labelledTree.label,
        folderIcon: vscode.ThemeIcon.Folder.id,
        error: { code: vscode.FileSystemError.FileNotADirectory(remote).code, message: vscode.FileSystemError.FileNotADirectory(remote).message },
      };
    }
    if (scenario === "text") {
      const markdown = new vscode.MarkdownString().appendText("**value**");
      const code = new vscode.MarkdownString().appendCodeblock("\x60\x60\x60\nvalue", "js");
      const snippet = new vscode.SnippetString().appendText("$x}")
        .appendPlaceholder(nested => nested.appendText("a").appendTabstop())
        .appendChoice(["a,b", "c|d"]);
      const edits = new vscode.WorkspaceEdit();
      const uri = vscode.Uri.file("/project/main.ts");
      edits.set(uri, [vscode.TextEdit.replace(new vscode.Range(0, 0, 0, 1), "x")]);
      const completion = new vscode.CompletionItem("name", vscode.CompletionItemKind.Variable);
      completion.additionalTextEdits = edits.get(uri);
      const list = new vscode.CompletionList([completion], true);
      const symbol = new vscode.DocumentSymbol("name", "variable", vscode.SymbolKind.Variable, new vscode.Range(0, 0, 1, 0), new vscode.Range(0, 0, 0, 4));
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 4), "missing", vscode.DiagnosticSeverity.Warning);
      diagnostic.source = "fixture";
      diagnostic.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(uri, new vscode.Position(1, 0)), "declared here")];
      return {
        markdown: markdown.value, code: code.value, snippet: snippet.value,
        eol: vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF).newEol,
        actionKind: vscode.CodeActionKind.Source.append("fixAll").value,
        sourceContainsFix: vscode.CodeActionKind.Source.contains(vscode.CodeActionKind.SourceFixAll),
        enumName: vscode.CompletionItemKind[vscode.CompletionItemKind.Folder],
        lastColumn: vscode.ViewColumn.Nine,
        complete: { count: list.items.length, incomplete: list.isIncomplete, edit: list.items[0].additionalTextEdits[0].newText },
        children: symbol.children,
        diagnostic: { severity: diagnostic.severity, source: diagnostic.source, related: diagnostic.relatedInformation[0].message },
      };
    }
    if (scenario === "builtin-values") {
      class GitTimelineItem extends vscode.TimelineItem {
        constructor() { super("Commit", 123); this.contextValue = "git:file:commit"; }
      }
      const timeline = new GitTimelineItem();
      const resource = new vscode.TimelineItem(vscode.Uri.file("/project/main.ts"), 456);
      const range = new vscode.Range(0, 0, 1, 0);
      const selection = new vscode.Range(0, 0, 0, 4);
      const call = new vscode.CallHierarchyItem(vscode.SymbolKind.Function, "main", "detail", resource.resourceUri, range, selection);
      const type = new vscode.TypeHierarchyItem(vscode.SymbolKind.Class, "Main", "class", resource.resourceUri, range, selection);
      const incoming = new vscode.CallHierarchyIncomingCall(call, [selection]);
      const outgoing = new vscode.CallHierarchyOutgoingCall(call, [selection]);
      const linked = new vscode.LinkedEditingRanges([selection, new vscode.Range(2, 0, 2, 4)], /[a-z]+/);
      return {
        timeline: { label: timeline.label, timestamp: timeline.timestamp, contextValue: timeline.contextValue, instance: timeline instanceof vscode.TimelineItem },
        resource: { label: resource.label ?? null, path: resource.resourceUri.path, timestamp: resource.timestamp },
        call: { name: call.name, detail: call.detail, kind: call.kind, path: call.uri.path, incoming: incoming.from === call, outgoing: outgoing.to === call, range: incoming.fromRanges[0] },
        type: { name: type.name, kind: type.kind, path: type.uri.path, standalone: !(type instanceof vscode.CallHierarchyItem) },
        linked: { count: linked.ranges.length, pattern: linked.wordPattern.source },
        severities: [vscode.LanguageStatusSeverity.Information, vscode.LanguageStatusSeverity.Warning, vscode.LanguageStatusSeverity.Error],
      };
    }
    if (scenario === "semantic-tokens") {
      const legend = new vscode.SemanticTokensLegend(["class", "function"], ["declaration", "async"]);
      const builder = new vscode.SemanticTokensBuilder(legend);
      builder.push(2, 4, 3, 1, 2);
      builder.push(new vscode.Range(0, 1, 0, 4), "class", ["declaration"]);
      builder.push(0, 8, 2, 1);
      const first = builder.build("first");
      builder.push(1, 2, 1, 0, 1);
      const second = builder.build("second");
      const failures = [];
      for (const push of [
        () => new vscode.SemanticTokensBuilder().push(new vscode.Range(0, 0, 0, 1), "class"),
        () => builder.push(new vscode.Range(0, 0, 1, 1), "class"),
        () => builder.push(new vscode.Range(0, 0, 0, 1), "unknown"),
        () => builder.push(new vscode.Range(0, 0, 0, 1), "class", ["unknown"]),
        () => builder.push(0, 0, 1, "class"),
      ]) { try { push(); failures.push(false); } catch { failures.push(true); } }
      const changes = new vscode.SemanticTokensEdits([new vscode.SemanticTokensEdit(0, 5, first.data)], "changes");
      return { first: Array.from(first.data), second: Array.from(second.data), firstId: first.resultId, secondId: second.resultId,
        typed: first.data instanceof Uint32Array, semantic: first instanceof vscode.SemanticTokens,
        empty: Array.from(new vscode.SemanticTokensBuilder().build().data), failures,
        edits: { id: changes.resultId, start: changes.edits[0].start, deleteCount: changes.edits[0].deleteCount, sameData: changes.edits[0].data === first.data } };
    }
    if (scenario === "tab-inputs") {
      const a = vscode.Uri.file("/project/a.ts"), b = vscode.Uri.file("/project/b.ts");
      const inputs = [new vscode.TabInputText(a), new vscode.TabInputTextDiff(a, b), new vscode.TabInputNotebook(a, "notebook"),
        new vscode.TabInputNotebookDiff(a, b, "notebook"), new vscode.TabInputCustom(a, "custom"), new vscode.TabInputWebview("webview"), new vscode.TabInputTerminal()];
      const highlight = new vscode.MultiDocumentHighlight(a, [new vscode.DocumentHighlight(new vscode.Range(0, 0, 0, 1))]);
      const transfer = new vscode.DataTransfer([["TEXT/PLAIN", new vscode.DataTransferItem("first")], ["text/plain", new vscode.DataTransferItem("second")]]);
      const first = await transfer.get("Text/Plain").asString();
      const duplicates = [...transfer].length;
      transfer.set("text/PLAIN", new vscode.DataTransferItem("replacement"));
      const paste = new vscode.DocumentPasteEdit("pasted", "Paste", vscode.DocumentDropOrPasteEditKind.TextUpdateImports);
      return { constructors: inputs.map(input => input.constructor.name), paths: [inputs[0].uri.path, inputs[1].modified.path],
        notebook: inputs[3].notebookType, custom: inputs[4].viewType, webview: inputs[5].viewType,
        highlight: { path: highlight.uri.path, count: highlight.highlights.length },
        transfer: { first, duplicates, replaced: await transfer.get("TEXT/PLAIN").asString(), count: [...transfer].length },
        paste: { text: paste.insertText, title: paste.title, kind: paste.kind.value } };
    }
    if (scenario === "tabs") {
      const groups = vscode.window.tabGroups;
      const tabEvents = [], groupEvents = [], states = [];
      const listeners = [groups.onDidChangeTabs(event => tabEvents.push([event.opened.length, event.changed.length, event.closed.length])),
        groups.onDidChangeTabGroups(event => groupEvents.push([event.opened.length, event.changed.length, event.closed.length])),
        vscode.window.onDidChangeWindowState(state => states.push(state))];
      const tab = { id: "tab1", label: "main.ts", input: { kind: "text", uri: vscode.Uri.file("/project/main.ts").toJSON() }, isActive: true, isDirty: false, isPinned: false, isPreview: true };
      const group = { id: "group1", isActive: true, viewColumn: 1, tabs: [tab] };
      await vscode.commands.executeCommand("__win.syncTabGroups", { groups: [group] });
      const firstGroup = groups.activeTabGroup, firstTab = firstGroup.activeTab, firstInput = firstTab.input;
      await vscode.commands.executeCommand("__win.syncTabGroups", { groups: [{ ...group, tabs: [{ ...tab, isDirty: true, isPreview: false }] }] });
      const stable = groups.activeTabGroup === firstGroup && firstGroup.activeTab === firstTab && firstTab.input === firstInput;
      const dirty = firstTab.isDirty && !firstTab.isPreview;
      await vscode.commands.executeCommand("__win.syncTabGroups", { groups: [{ ...group, tabs: [], isActive: false }, { id: "group2", isActive: true, viewColumn: 2, tabs: [{ ...tab, isDirty: true }] }] });
      const moved = firstTab.group === groups.activeTabGroup && groups.activeTabGroup.activeTab === firstTab;
      const closedTab = await groups.close(firstTab, true);
      const closedGroup = await groups.close(firstGroup);
      await vscode.commands.executeCommand("__win.syncTabGroups", { groups: [{ ...group, tabs: [] }] });
      let staleRejected = false;
      try { await groups.close(firstTab); } catch { staleRejected = true; }
      await vscode.commands.executeCommand("__win.syncState", { focused: true, active: true });
      await vscode.commands.executeCommand("__win.syncState", { focused: true, active: true });
      await vscode.commands.executeCommand("__win.syncState", { focused: false, active: true });
      await vscode.commands.executeCommand("__win.syncState", { focused: false, active: false });
      listeners.forEach(listener => listener.dispose());
      return { stable, dirty, moved, closedTab, closedGroup, staleRejected, textInput: firstInput instanceof vscode.TabInputText,
        uri: firstInput.uri.path, tabEvents, groupEvents, states, state: vscode.window.state };
    }
    if (scenario === "diff-information") {
      const uri = vscode.Uri.file("/project/diff.ts");
      const snapshot = { document: { uri: uri.toJSON(), text: "text", version: 1, languageId: "typescript", isDirty: false, eol: 1 }, selections: [], visibleRanges: [], options: {} };
      const events = [];
      const listener = vscode.window.onDidChangeTextEditorDiffInformation(event => events.push({
        same: event.textEditor === vscode.window.activeTextEditor,
        original: event.diffInformation?.[0].original?.scheme ?? null,
        modified: event.diffInformation?.[0].modified.path ?? null,
        kind: event.diffInformation?.[0].changes[0].kind ?? null,
        stale: event.diffInformation?.[0].isStale ?? null,
      }));
      await vscode.commands.executeCommand("__win.syncEditors", { active: snapshot, visible: [snapshot] });
      const unavailable = vscode.window.activeTextEditor.diffInformation === undefined;
      const info = { documentVersion: 1, original: uri.with({ scheme: "git" }).toJSON(), modified: uri.toJSON(), isStale: false,
        changes: [{ original: { startLineNumber: 1, endLineNumberExclusive: 2 }, modified: { startLineNumber: 1, endLineNumberExclusive: 2 }, kind: vscode.TextEditorChangeKind.Modification }] };
      const withDiff = { ...snapshot, diffInformation: [info] };
      await vscode.commands.executeCommand("__win.onDidChangeTextEditorDiffInformation", { textEditor: withDiff });
      await vscode.commands.executeCommand("__win.syncEditors", { active: withDiff, visible: [withDiff] });
      await vscode.commands.executeCommand("__win.onDidChangeTextEditorDiffInformation", { textEditor: { ...snapshot, diffInformation: [{ ...info, isStale: true }] } });
      await vscode.commands.executeCommand("__win.onDidChangeTextEditorDiffInformation", { textEditor: snapshot });
      listener.dispose();
      return { unavailable, events, cleared: vscode.window.activeTextEditor.diffInformation === undefined };
    }
    if (scenario === "lifecycle") {
      let disposalCount = 0;
      const disposable = new vscode.Disposable(() => disposalCount++);
      disposable.dispose(); disposable.dispose();
      const emitter = new vscode.EventEmitter();
      const listeners = [];
      const events = [];
      const listener = function(value) { events.push(this.prefix + value); };
      emitter.event(listener, { prefix: "bound:" }, listeners);
      emitter.event(listener, { prefix: "bound:" }, listeners);
      emitter.fire(1);
      listeners[0].dispose();
      emitter.fire(2);
      const token = new vscode.CancellationTokenSource();
      token.cancel();
      const lateNotification = await new Promise(resolve => token.token.onCancellationRequested(() => resolve(true)));
      emitter.dispose(); token.dispose();
      return { disposalCount, events, registeredDisposables: listeners.length, cancelled: token.token.isCancellationRequested, lateNotification };
    }
    throw new Error("Unknown scenario");
  }));
};
`;

async function runExtension<T>(scenario: string): Promise<T> {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-value-types-"));
  const extensions = join(root, "extensions");
  const directory = join(extensions, "audit");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "values",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:audit.values"],
    }),
  );
  writeFileSync(join(directory, "extension.cjs"), extensionSource);
  const hostFixture = await createExtensionHostFixture();
  const host = hostFixture.service;
  const unsubscribe = host.onMainThreadCall(async (_session, _method, _args, requestId) => {
    if (requestId)
      host.resolveMainCall(
        requestId,
        _method === "window.closeTabs" || _method === "window.closeTabGroups" ? true : undefined,
      );
  });
  try {
    await host.scanExtensions(extensions);
    await host.startSession("value-types", [root]);
    return await host.executeCommand<T>("value-types", "audit.values", scenario);
  } finally {
    await hostFixture.dispose("value-types");
    unsubscribe();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("VS Code values in a real extension host", () => {
  it("encodes and decodes workspace text with the configured codec, BOMs and detection", async () => {
    expect(await runExtension("encoding")).toEqual({
      typed: true,
      utf8: [0xc3, 0xa9],
      utf8BOM: [0xef, 0xbb, 0xbf, 0xc3, 0xa9],
      utf16: [0xfe, 0xff, 0x00, 0xe9],
      decodedUtf16: "é",
      emptyUtf16: [0xff, 0xfe],
      decodedView: "é",
      decodedWithoutBOM: "AB",
      configured: [0x80],
      decodedConfigured: "€",
      scoped: [0xff, 0xfe, 0xe9, 0x00],
      settingsBytes: [0xc3, 0xa9],
      unsupported: [0xc3, 0xa9],
      guessed: "Текст для надёжного определения кодировки.",
      rejectsBinary: true,
    });
  });

  it("preserves normalized ranges and reversed selections with standard position methods", async () => {
    expect(await runExtension("geometry")).toEqual({
      rejectsNegative: true,
      before: true,
      translation: { line: 3, character: 1 },
      samePosition: true,
      range: {
        start: { line: 1, character: 1 },
        end: { line: 4, character: 2 },
        singleLine: false,
      },
      intersection: { start: { line: 1, character: 1 }, end: { line: 2, character: 0 } },
      contains: true,
      selection: {
        start: { line: 1, character: 1 },
        end: { line: 4, character: 2 },
        active: { line: 1, character: 1 },
        reversed: true,
      },
    });
  });

  it("keeps URI components and separates edits for local and remote resources", async () => {
    const result = await runExtension<Record<string, unknown>>("resources");
    expect(result).toMatchObject({
      remote: {
        scheme: "vscode-remote",
        authority: "ssh-remote+fixture",
        path: "/workspace/file name.ts",
        query: "view=1",
        fragment: "L2",
      },
      joined: {
        path: "/workspace/other.ts",
        query: "view=1",
        fragment: "L2",
        authority: "ssh-remote+fixture",
      },
      file: "file:///tmp/project%23draft/file%3F.ts",
      editSize: 2,
      remoteText: ["remote"],
      hasLocal: true,
      base: "/elsewhere",
      label: { label: "match", highlights: [[0, 1]] },
      folderIcon: "folder",
      error: { code: "FileNotADirectory" },
    });
    expect(result.treeUri).toContain("vscode-remote://");
  });

  it("constructs snippets, escaped Markdown and language feature result values", async () => {
    expect(await runExtension("text")).toEqual({
      markdown: "\\*\\*value\\*\\*",
      code: "\n````js\n```\nvalue\n````\n",
      snippet: "\\$x\\}${1:a$2}${3|a\\,b,c\\|d|}",
      eol: 2,
      actionKind: "source.fixAll",
      sourceContainsFix: true,
      enumName: "Folder",
      lastColumn: 9,
      complete: { count: 1, incomplete: true, edit: "x" },
      children: [],
      diagnostic: { severity: 1, source: "fixture", related: "declared here" },
    });
  });

  it("binds independent listeners, disposes once and notifies late cancellation subscribers", async () => {
    expect(await runExtension("lifecycle")).toEqual({
      disposalCount: 1,
      events: ["bound:1", "bound:1", "bound:2"],
      registeredDisposables: 2,
      cancelled: true,
      lateNotification: true,
    });
  });

  it("constructs the timeline and hierarchy values required by the shipped Git and TypeScript extensions", async () => {
    expect(await runExtension("builtin-values")).toEqual({
      timeline: {
        label: "Commit",
        timestamp: 123,
        contextValue: "git:file:commit",
        instance: true,
      },
      resource: { label: null, path: "/project/main.ts", timestamp: 456 },
      call: {
        name: "main",
        detail: "detail",
        kind: 11,
        path: "/project/main.ts",
        incoming: true,
        outgoing: true,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      },
      type: { name: "Main", kind: 4, path: "/project/main.ts", standalone: true },
      linked: { count: 2, pattern: "[a-z]+" },
      severities: [0, 1, 2],
    });
  });

  it("builds sorted delta-encoded semantic tokens from both overloads without mutating previous results", async () => {
    expect(await runExtension("semantic-tokens")).toEqual({
      first: [0, 1, 3, 0, 1, 0, 7, 2, 1, 0, 2, 4, 3, 1, 2],
      second: [0, 1, 3, 0, 1, 0, 7, 2, 1, 0, 1, 2, 1, 0, 1, 1, 4, 3, 1, 2],
      firstId: "first",
      secondId: "second",
      typed: true,
      semantic: true,
      empty: [],
      failures: [true, true, true, true, true],
      edits: { id: "changes", start: 0, deleteCount: 5, sameData: true },
    });
  });

  it("constructs shipped tab inputs, multi-document highlights and paste values", async () => {
    expect(await runExtension("tab-inputs")).toEqual({
      constructors: [
        "TabInputText",
        "TabInputTextDiff",
        "TabInputNotebook",
        "TabInputNotebookDiff",
        "TabInputCustom",
        "TabInputWebview",
        "TabInputTerminal",
      ],
      paths: ["/project/a.ts", "/project/b.ts"],
      notebook: "notebook",
      custom: "custom",
      webview: "webview",
      highlight: { path: "/project/a.ts", count: 1 },
      transfer: { first: "first", duplicates: 2, replaced: "replacement", count: 1 },
      paste: { text: "pasted", title: "Paste", kind: "text.updateImports" },
    });
  });

  it("retains live tab identity across groups and forwards close requests and window state transitions", async () => {
    expect(await runExtension("tabs")).toEqual({
      stable: true,
      dirty: true,
      moved: true,
      closedTab: true,
      closedGroup: true,
      staleRejected: true,
      textInput: true,
      uri: "/project/main.ts",
      tabEvents: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      groupEvents: [
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 1],
      ],
      states: [
        { focused: true, active: true },
        { focused: false, active: true },
        { focused: false, active: false },
      ],
      state: { focused: false, active: false },
    });
  });

  it("forwards supplied diff information changes and leaves single-text editors without invented diffs", async () => {
    expect(await runExtension("diff-information")).toEqual({
      unavailable: true,
      cleared: true,
      events: [
        { same: true, original: "git", modified: "/project/diff.ts", kind: 3, stale: false },
        { same: true, original: "git", modified: "/project/diff.ts", kind: 3, stale: true },
        { same: true, original: null, modified: null, kind: null, stale: null },
      ],
    });
  });
});
