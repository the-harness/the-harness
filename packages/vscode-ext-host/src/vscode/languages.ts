import type { languages as monacoLanguages } from "monaco-editor";
import { score as scoreDocumentSelector } from "monaco-editor/esm/vs/editor/common/languageSelector.js";
import picomatch from "picomatch";
import type { ExtHostBridge } from "./bridge.ts";
import { registerColorCommands, reviveColor } from "./color-commands.ts";
import { createEditorDiagnostics, type EditorDiagnosticsSnapshot } from "./editor-diagnostics.ts";
import { getTextDocuments, reviveTextDocument } from "./document.ts";
import { getNotebookForCell } from "./notebooks.ts";
import { registerWordPattern } from "./document.ts";
import { createWorkspaceSymbolApi } from "./workspace-symbols.ts";
import {
  CancellationTokenSource,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  Disposable,
  DataTransfer,
  DataTransferItem,
  EventEmitter,
  Position,
  Range,
  Uri,
  WorkspaceEdit,
  type Color,
  type Command,
  type LanguageConfiguration,
  type TextDocumentSnapshot,
} from "@harness/vscode-types";

export { Diagnostic, DiagnosticSeverity };

let providerCounter = 0;
let collectionCounter = 0;
type Provider = Record<string, unknown>;
type DocumentFilter = {
  language?: string;
  scheme?: string;
  pattern?: string | { baseUri?: UriData; base?: string; pattern: string };
  notebookType?: string;
};
export type DocumentSelector = string | DocumentFilter | readonly (string | DocumentFilter)[];
type MatchDocument = { uri: Uri; languageId: string };

function toMonacoFilter(filter: string | DocumentFilter): string | monacoLanguages.LanguageFilter {
  if (!filter || typeof filter === "string") return filter;
  const { language, scheme, notebookType, pattern } = filter;
  if (!pattern || typeof pattern === "string") return { language, scheme, notebookType, pattern };

  const base = pattern.baseUri ? uriFrom(pattern.baseUri).fsPath : pattern.base;
  return base
    ? { language, scheme, notebookType, pattern: { base, pattern: pattern.pattern } }
    : {};
}

type UriData = {
  scheme?: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
};

function uriFrom(value: UriData): Uri {
  return Uri.from({ ...value, scheme: value.scheme ?? "file" });
}

function revive(value: unknown, bridge: ExtHostBridge, token: CancellationTokenSource): unknown {
  if (Array.isArray(value)) return value.map((entry) => revive(entry, bridge, token));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if ("isCancellationRequested" in object) {
    if (object.isCancellationRequested) token.cancel();
    return token.token;
  }
  if ("text" in object && "languageId" in object && "uri" in object) {
    return reviveTextDocument(bridge, object as unknown as TextDocumentSnapshot);
  }
  if (typeof object.line === "number" && typeof object.character === "number") {
    return new Position(object.line, object.character);
  }
  if (object.start && object.end) {
    const start = revive(object.start, bridge, token);
    const end = revive(object.end, bridge, token);
    if (start instanceof Position && end instanceof Position) return new Range(start, end);
  }
  if (
    typeof object.scheme === "string" &&
    (typeof object.path === "string" || object.$mid === 1 || typeof object.authority === "string")
  )
    return uriFrom(object as UriData);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, revive(entry, bridge, token)]),
  );
}

function serialize(value: unknown): unknown {
  if (value instanceof Uint32Array) return [...value];
  if (value instanceof RegExp) return { source: value.source, flags: value.flags };
  if (value instanceof WorkspaceEdit) {
    if (value._allEntries().some((entry) => entry.type !== "text")) {
      throw new Error(
        "Language provider WorkspaceEdit file, snippet and notebook operations are not supported",
      );
    }
    return { entries: value.entries().map(([uri, edits]) => [uri.toJSON(), edits.map(serialize)]) };
  }
  if (value instanceof Uri) return value.toJSON();
  if (Array.isArray(value)) return value.map(serialize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, serialize(entry)]));
}

export function createLanguagesNamespace(
  bridge: ExtHostBridge,
  applyEdit: (edit: WorkspaceEdit) => Promise<boolean>,
  windowState?: {
    getActiveDocument(): MatchDocument | undefined;
    onDidChangeActiveEditor(listener: (event: unknown) => unknown): { dispose(): void };
  },
) {
  registerColorCommands(bridge);
  const collections = new Map<string, Map<string, [Uri, readonly Diagnostic[]]>>();
  const changed = new EventEmitter<{ uris: readonly Uri[] }>();
  const editorDiagnostics = createEditorDiagnostics((uris) => changed.fire({ uris }));
  bridge.commandHandlers.set("__languages.syncEditorDiagnostics", (entries) => {
    editorDiagnostics.accept(entries as EditorDiagnosticsSnapshot, true);
  });
  bridge.commandHandlers.set("__languages.updateEditorDiagnostics", (entries) => {
    editorDiagnostics.accept(entries as EditorDiagnosticsSnapshot);
  });
  const workspaceSymbols = createWorkspaceSymbolApi(bridge);
  const locationProviders = new Map<
    string,
    { kind: string; selector: DocumentSelector; provider: Provider }
  >();
  const callHierarchyProviders = new Map<
    string,
    { selector: DocumentSelector; provider: Provider }
  >();
  const callHierarchySessions = new Map<
    string,
    { providerId: string; items: Map<string, CallHierarchyItem> }
  >();
  const multiHighlightProviders = new Map<
    string,
    { selector: DocumentSelector; provider: Provider }
  >();
  const dropProviders = new Map<
    string,
    {
      selector: DocumentSelector;
      provider: Provider;
      metadata?: { dropMimeTypes: readonly string[] };
    }
  >();
  const pasteProviders = new Map<
    string,
    {
      selector: DocumentSelector;
      provider: Provider;
      metadata: { pasteMimeTypes: readonly string[] };
    }
  >();

  function matchDocument(selector: DocumentSelector, document: MatchDocument) {
    const filters = Array.isArray(selector)
      ? selector.map(toMonacoFilter)
      : toMonacoFilter(selector as string | DocumentFilter);
    const notebook = getNotebookForCell(bridge, document.uri);
    return scoreDocumentSelector(
      filters,
      document.uri,
      document.languageId,
      true,
      notebook?.uri,
      notebook?.notebookType,
    );
  }

  async function documentFor(uri: Uri) {
    const cached = getTextDocuments(bridge).get(uri.toString());
    return (
      cached ??
      reviveTextDocument(
        bridge,
        (await bridge.callMain("workspace.openTextDocument", uri.toJSON())) as TextDocumentSnapshot,
      )
    );
  }

  for (const [command, kind, method] of [
    ["vscode.executeReferenceProvider", "reference", "provideReferences"],
    ["vscode.executeImplementationProvider", "implementation", "provideImplementation"],
  ] as const) {
    bridge.commandHandlers.set(command, async (rawUri, rawPosition) => {
      const source = new CancellationTokenSource();
      try {
        const document = await documentFor(revive(rawUri, bridge, source) as Uri);
        const position = revive(rawPosition, bridge, source) as Position;
        const candidates = [...locationProviders.values()].filter(
          (entry) => entry.kind === kind && matchDocument(entry.selector, document) > 0,
        );
        const results = await Promise.all(
          candidates.map(({ provider }) =>
            (provider[method] as (...args: unknown[]) => unknown).call(
              provider,
              document,
              position,
              ...(kind === "reference" ? [{ includeDeclaration: true }] : []),
              source.token,
            ),
          ),
        );
        return results.flatMap((result) =>
          Array.isArray(result) ? result : result ? [result] : [],
        );
      } finally {
        source.dispose();
      }
    });
  }

  function exposeCallHierarchyItem(sessionId: string, item: CallHierarchyItem) {
    const session = callHierarchySessions.get(sessionId)!;
    const itemId = String(session.items.size);
    session.items.set(itemId, item);
    const result = new CallHierarchyItem(
      item.kind,
      item.name,
      item.detail ?? "",
      item.uri,
      item.range,
      item.selectionRange,
    );
    result.tags = item.tags;
    return Object.assign(result, { _sessionId: sessionId, _itemId: itemId });
  }

  bridge.commandHandlers.set("vscode.prepareCallHierarchy", async (rawUri, rawPosition) => {
    const source = new CancellationTokenSource();
    try {
      const uri = revive(rawUri, bridge, source) as Uri;
      const position = revive(rawPosition, bridge, source) as Position;
      const document = await documentFor(uri);
      const candidates = [...callHierarchyProviders.entries()]
        .reverse()
        .map(([id, entry]) => ({ id, ...entry, score: matchDocument(entry.selector, document) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      for (const { id, provider } of candidates) {
        const value = await (provider.prepareCallHierarchy as (...args: unknown[]) => unknown).call(
          provider,
          document,
          position,
          source.token,
        );
        const items = (Array.isArray(value) ? value : value ? [value] : []) as CallHierarchyItem[];
        if (!items.length) continue;
        const sessionId = `call-${++providerCounter}`;
        callHierarchySessions.set(sessionId, { providerId: id, items: new Map() });
        if (callHierarchySessions.size > 10)
          callHierarchySessions.delete(callHierarchySessions.keys().next().value!);
        return [exposeCallHierarchyItem(sessionId, items[0]!)];
      }
      return [];
    } finally {
      source.dispose();
    }
  });

  for (const [command, method, direction] of [
    ["vscode.provideIncomingCalls", "provideCallHierarchyIncomingCalls", "from"],
    ["vscode.provideOutgoingCalls", "provideCallHierarchyOutgoingCalls", "to"],
  ] as const) {
    bridge.commandHandlers.set(command, async (rawItem) => {
      const handle = rawItem as { _sessionId?: string; _itemId?: string };
      const session = handle?._sessionId ? callHierarchySessions.get(handle._sessionId) : undefined;
      const provider = session
        ? callHierarchyProviders.get(session.providerId)?.provider
        : undefined;
      const item = handle?._itemId !== undefined ? session?.items.get(handle._itemId) : undefined;
      if (!provider || !item) return [];
      const source = new CancellationTokenSource();
      try {
        const result = await (provider[method] as (...args: unknown[]) => unknown).call(
          provider,
          item,
          source.token,
        );
        if (!Array.isArray(result)) return [];
        return result.map((call: CallHierarchyIncomingCall | CallHierarchyOutgoingCall) =>
          direction === "from"
            ? new CallHierarchyIncomingCall(
                exposeCallHierarchyItem(
                  handle._sessionId!,
                  (call as CallHierarchyIncomingCall).from,
                ),
                call.fromRanges,
              )
            : new CallHierarchyOutgoingCall(
                exposeCallHierarchyItem(handle._sessionId!, (call as CallHierarchyOutgoingCall).to),
                call.fromRanges,
              ),
        );
      } finally {
        source.dispose();
      }
    });
  }

  bridge.commandHandlers.set(
    "__languages.executeMultiDocumentHighlightProvider",
    async (rawUri, rawPosition, rawOthers) => {
      const source = new CancellationTokenSource();
      try {
        const document = await documentFor(revive(rawUri, bridge, source) as Uri);
        const position = revive(rawPosition, bridge, source) as Position;
        const others = await Promise.all(
          (rawOthers as unknown[]).map((uri) => documentFor(revive(uri, bridge, source) as Uri)),
        );
        const results = await Promise.all(
          [...multiHighlightProviders.values()]
            .filter(({ selector }) => matchDocument(selector, document) > 0)
            .map(({ provider }) =>
              (provider.provideMultiDocumentHighlights as (...args: unknown[]) => unknown).call(
                provider,
                document,
                position,
                others,
                source.token,
              ),
            ),
        );
        return serialize(results.flatMap((result) => (Array.isArray(result) ? result : [])));
      } finally {
        source.dispose();
      }
    },
  );

  bridge.commandHandlers.set("__languages.executeDocumentPasteEditProvider", async (rawRequest) => {
    const source = new CancellationTokenSource();
    try {
      const request = revive(rawRequest, bridge, source) as {
        source: { uri: Uri; ranges: Range[] };
        target: { uri: Uri; ranges: Range[] };
        text: string;
      };
      const copyDocument = await documentFor(request.source.uri);
      const pasteDocument = await documentFor(request.target.uri);
      const transfer = new DataTransfer([["text/plain", new DataTransferItem(request.text)]]);
      for (const { selector, provider } of pasteProviders.values()) {
        if (
          !matchDocument(selector, copyDocument) ||
          typeof provider.prepareDocumentPaste !== "function"
        )
          continue;
        await provider.prepareDocumentPaste.call(
          provider,
          copyDocument,
          request.source.ranges,
          transfer,
          source.token,
        );
      }
      const edits: unknown[] = [];
      for (const { selector, provider, metadata } of pasteProviders.values()) {
        if (!matchDocument(selector, pasteDocument)) continue;
        if (
          !metadata.pasteMimeTypes.some((pattern) =>
            [...transfer].some(([mime]) => picomatch(pattern)(mime)),
          )
        )
          continue;
        const result = await (
          provider.provideDocumentPasteEdits as (...args: unknown[]) => unknown
        ).call(
          provider,
          pasteDocument,
          request.target.ranges,
          transfer,
          { triggerKind: 0 },
          source.token,
        );
        if (!Array.isArray(result)) continue;
        for (const edit of result)
          edits.push(
            typeof provider.resolveDocumentPasteEdit === "function"
              ? ((await provider.resolveDocumentPasteEdit.call(provider, edit, source.token)) ??
                  edit)
              : edit,
          );
      }
      return serialize(edits);
    } finally {
      source.dispose();
    }
  });

  bridge.commandHandlers.set("__languages.executeDocumentDropEditProvider", async (rawRequest) => {
    const source = new CancellationTokenSource();
    try {
      const request = revive(rawRequest, bridge, source) as {
        uri: Uri;
        position: Position;
        items: { mime: string; value: unknown }[];
      };
      const document = await documentFor(request.uri);
      const transfer = new DataTransfer(
        request.items.map(({ mime, value }) => [mime, new DataTransferItem(value)]),
      );
      const edits: unknown[] = [];
      for (const { selector, provider, metadata } of dropProviders.values()) {
        if (!matchDocument(selector, document)) continue;
        if (
          metadata &&
          !metadata.dropMimeTypes.some((pattern) =>
            [...transfer].some(([mime]) => picomatch(pattern)(mime)),
          )
        )
          continue;
        const result = await (
          provider.provideDocumentDropEdits as (...args: unknown[]) => unknown
        ).call(provider, document, request.position, transfer, source.token);
        for (const edit of Array.isArray(result) ? result : result ? [result] : []) {
          edits.push(
            typeof provider.resolveDocumentDropEdit === "function"
              ? ((await provider.resolveDocumentDropEdit.call(provider, edit, source.token)) ??
                  edit)
              : edit,
          );
        }
      }
      return serialize(edits);
    } finally {
      source.dispose();
    }
  });

  function register(
    kind: string,
    selector: unknown,
    provider: Provider,
    methods: readonly string[],
    metadata?: unknown,
  ) {
    const id = `p-${++providerCounter}`;
    const command = `__lang.provide.${id}`;
    const available = methods.filter((name) => typeof provider[name] === "function");
    if (kind === "reference" || kind === "implementation")
      locationProviders.set(id, { kind, selector: selector as DocumentSelector, provider });
    const subscriptions: { dispose(): void }[] = [];
    const itemLists = new Map<number, Record<string, unknown>[]>();
    const mixedActions = new WeakMap<
      Record<string, unknown>[],
      Map<
        number,
        {
          edit: WorkspaceEdit;
          command?: Command;
        }
      >
    >();
    let nextItemList = 0;
    let disposed = false;
    const cacheType =
      kind === "documentLink"
        ? "DocumentLink"
        : kind === "codeLens"
          ? "CodeLens"
          : kind === "codeAction"
            ? "CodeAction"
            : kind === "inlayHints"
              ? "InlayHint"
              : "Completion";
    const cacheCommands = kind === "completion" || kind === "codeLens";
    const cacheItems =
      cacheCommands || kind === "documentLink" || kind === "codeAction" || kind === "inlayHints";
    const releaseCommand = `__lang.release${cacheType}.${id}`;
    const acceptCommand = `__lang.accept${cacheType}.${id}`;
    const applyCommand = `__lang.applyCodeAction.${id}`;
    const serializeItem = (
      item: Record<string, unknown>,
      listId: number,
      itemIndex: number,
      items: Record<string, unknown>[],
    ) => {
      let fields: readonly string[];
      if (kind === "codeAction") {
        fields =
          typeof item.command === "string"
            ? ["title", "command", "tooltip", "arguments"]
            : ["title", "kind", "edit", "command", "diagnostics", "disabled", "isPreferred"];
      } else if (kind === "documentLink") {
        fields = ["range", "target", "tooltip"];
      } else if (kind === "codeLens") {
        fields = ["range"];
      } else if (kind === "inlayHints") {
        fields = [
          "position",
          "label",
          "kind",
          "tooltip",
          "textEdits",
          "paddingLeft",
          "paddingRight",
        ];
      } else {
        fields = [
          "label",
          "kind",
          "tags",
          "detail",
          "documentation",
          "insertText",
          "range",
          "sortText",
          "filterText",
          "preselect",
          "commitCharacters",
          "additionalTextEdits",
          "keepWhitespace",
          "textEdit",
        ];
      }
      const edit = item.edit;
      const mixed =
        kind === "codeAction" &&
        edit instanceof WorkspaceEdit &&
        edit
          ._allEntries()
          .some((entry) => entry.type !== "text" || entry.metadata?.needsConfirmation);
      if (mixed) {
        fields = fields.filter((field) => field !== "edit" && field !== "command");
        let actions = mixedActions.get(items);
        if (!actions) {
          actions = new Map();
          mixedActions.set(items, actions);
        }
        actions.set(itemIndex, { edit, command: item.command as Command | undefined });
      }
      const result = Object.fromEntries(
        fields.filter((field) => field in item).map((field) => [field, serialize(item[field])]),
      );
      result[`_harness${cacheType}`] = [listId, itemIndex];
      if (mixed) result._harnessApplyWorkspaceEdit = true;
      if (!cacheCommands) return result;
      const originalCommand = item.command as { title: string; tooltip?: string } | undefined;
      return {
        ...result,
        command: originalCommand
          ? {
              title: originalCommand.title,
              tooltip: originalCommand.tooltip,
              command: acceptCommand,
              arguments: [listId, itemIndex],
            }
          : undefined,
      };
    };
    if (cacheItems) {
      bridge.commandHandlers.set(releaseCommand, (listId) => {
        itemLists.delete(Number(listId));
      });
    }
    if (kind === "codeAction") {
      bridge.commandHandlers.set(applyCommand, async (listId, itemIndex) => {
        const items = itemLists.get(Number(listId));
        const action = items && mixedActions.get(items)?.get(Number(itemIndex));
        if (!action) throw new Error("This code action is no longer available");
        if (!(await applyEdit(action.edit)))
          throw new Error("Could not apply the code action's workspace edit");
        const command = action.command;
        if (!command) return;
        const callback = bridge.commandHandlers.get(command.command);
        return callback
          ? callback(...(command.arguments ?? []))
          : bridge.callMain("commands.execute", command.command, ...(command.arguments ?? []));
      });
    }
    if (cacheCommands) {
      bridge.commandHandlers.set(acceptCommand, async (listId, itemIndex) => {
        const item = itemLists.get(Number(listId))?.[Number(itemIndex)];
        const originalCommand = item?.command as
          | { command: string; arguments?: unknown[] }
          | undefined;
        if (!originalCommand) return;
        const callback = bridge.commandHandlers.get(originalCommand.command);
        return callback
          ? callback(...(originalCommand.arguments ?? []))
          : bridge.callMain(
              "commands.execute",
              originalCommand.command,
              ...(originalCommand.arguments ?? []),
            );
      });
      void bridge.callMain("commands.register", acceptCommand);
    }

    bridge.commandHandlers.set(command, async (methodName, ...rawArgs) => {
      if (typeof methodName !== "string" || !available.includes(methodName)) {
        throw new Error(`Unknown language provider method: ${String(methodName)}`);
      }
      const token = new CancellationTokenSource();
      const signal = bridge.getRequestSignal?.();
      const cancel = () => token.cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (signal?.aborted) {
          cancel();
          return undefined;
        }
        const args = rawArgs.map((value) => revive(value, bridge, token));
        if (methodName === "provideColorPresentations") args[0] = reviveColor(args[0] as Color);
        if (methodName === "provideCodeActions") {
          const context = args[2] as { only?: { value: string } } | undefined;
          if (context?.only) context.only = new CodeActionKind(context.only.value);
        }
        const handle = (rawArgs[0] as Record<string, [number, number]> | undefined)?.[
          `_harness${cacheType}`
        ];
        const resolvesItem =
          methodName === "resolveCompletionItem" ||
          methodName === "resolveCodeLens" ||
          methodName === "resolveDocumentLink" ||
          methodName === "resolveInlayHint" ||
          methodName === "resolveCodeAction";
        if (resolvesItem) {
          const original = handle ? itemLists.get(handle[0])?.[handle[1]] : undefined;
          if (!original) return undefined;
          args[0] = original;
        }
        const callback = provider[methodName] as (...values: unknown[]) => unknown;
        const result = await callback.apply(provider, args);
        if (signal?.aborted || disposed) return undefined;
        if (
          (methodName === "provideCompletionItems" ||
            methodName === "provideCodeLenses" ||
            methodName === "provideDocumentLinks" ||
            methodName === "provideInlayHints" ||
            methodName === "provideCodeActions") &&
          result
        ) {
          const list = result as { items: Record<string, unknown>[]; isIncomplete?: boolean };
          const items = (
            (Array.isArray(result) ? result : list.items) as Record<string, unknown>[]
          ).slice();
          const listId = ++nextItemList;
          const serialized = items.map((item, index) => serializeItem(item, listId, index, items));
          itemLists.set(listId, items);
          bridge.releaseDroppedResponse?.(releaseCommand, listId);
          return {
            items: serialized,
            isIncomplete: !Array.isArray(result) && !!list.isIncomplete,
            [`_harness${cacheType}List`]: listId,
          };
        }
        if (resolvesItem && result && handle) {
          const list = itemLists.get(handle[0]);
          if (!list) return undefined;
          if (methodName !== "resolveCodeAction" && methodName !== "resolveInlayHint")
            list[handle[1]] = result as Record<string, unknown>;
          return serializeItem(result as Record<string, unknown>, handle[0], handle[1], list);
        }
        return serialize(result);
      } finally {
        signal?.removeEventListener("abort", cancel);
        token.dispose();
      }
    });
    for (const name of [
      "onDidChangeCodeLenses",
      "onDidChangeInlayHints",
      "onDidChangeFoldingRanges",
      "onDidChangeSemanticTokens",
    ]) {
      const event = provider[name];
      if (typeof event === "function") {
        subscriptions.push(
          event.call(provider, () => void bridge.callMain("languages.providerChanged", id)),
        );
      }
    }
    void bridge.callMain("languages.registerProvider", kind, id, selector, metadata, available);
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        bridge.commandHandlers.delete(command);
        itemLists.clear();
        bridge.commandHandlers.delete(releaseCommand);
        bridge.commandHandlers.delete(acceptCommand);
        bridge.commandHandlers.delete(applyCommand);
        if (cacheCommands) void bridge.callMain("commands.unregister", acceptCommand);
        locationProviders.delete(id);
        for (const subscription of subscriptions) subscription.dispose();
        void bridge.callMain("languages.unregisterProvider", id);
      },
    };
  }

  return {
    ...workspaceSymbols,
    match: matchDocument,
    async getLanguages(): Promise<string[]> {
      return (await bridge.callMain("languages.getLanguages")) as string[];
    },
    setLanguageConfiguration(language: string, configuration: LanguageConfiguration): Disposable {
      const wordPattern = configuration.wordPattern;
      if (wordPattern && new RegExp(wordPattern.source, wordPattern.flags).test(""))
        throw new Error("Word definition must not match the empty string");
      const snapshot = serialize(configuration);
      const id = `language-configuration-${++providerCounter}`;
      const removeWordPattern = wordPattern && registerWordPattern(bridge, language, wordPattern);
      void bridge
        .callMain("languages.setLanguageConfiguration", id, language, snapshot)
        .catch((error: unknown) => {
          removeWordPattern?.();
          console.error(error);
        });
      return new Disposable(() => {
        removeWordPattern?.();
        void bridge.callMain("languages.disposeLanguageConfiguration", id).catch(console.error);
      });
    },
    onDidChangeDiagnostics: changed.event,
    getDiagnostics(uri?: Uri) {
      const sources = [...collections.values(), editorDiagnostics.entries];
      if (uri) {
        const key = uri.toString();
        return sources.flatMap((collection) => collection.get(key)?.[1] ?? []);
      }
      const merged = new Map<string, [Uri, Diagnostic[]]>();
      for (const collection of sources) {
        for (const [key, [resource, diagnostics]] of collection) {
          const entry: [Uri, Diagnostic[]] = merged.get(key) ?? [resource, []];
          entry[1].push(...diagnostics);
          merged.set(key, entry);
        }
      }
      return [...merged.values()];
    },
    createDiagnosticCollection(name = "") {
      const id = `diagnostics-${++collectionCounter}`;
      const entries = new Map<string, [Uri, readonly Diagnostic[]]>();
      collections.set(id, entries);
      let disposed = false;
      const ensureActive = () => {
        if (disposed) throw new Error("Diagnostic collection is disposed");
      };
      const notify = (uris: Uri[]) => changed.fire({ uris });
      const collection = {
        name,
        set(
          uriOrEntries?: Uri | readonly [Uri, readonly Diagnostic[] | undefined][],
          diagnostics?: readonly Diagnostic[],
        ) {
          ensureActive();
          if (uriOrEntries === undefined) return collection.clear();
          const updates = new Map<string, [Uri, Diagnostic[] | undefined]>();
          if (Array.isArray(uriOrEntries)) {
            for (const [uri, list] of uriOrEntries) {
              const key = uri.toString();
              const existing = updates.get(key)?.[1] ?? [];
              updates.set(key, [uri, list === undefined ? undefined : [...existing, ...list]]);
            }
          } else {
            const uri = uriOrEntries as Uri;
            updates.set(uri.toString(), [
              uri,
              diagnostics === undefined ? undefined : [...diagnostics],
            ]);
          }
          for (const [key, [uri, list]] of updates) {
            if (list === undefined) entries.delete(key);
            else entries.set(key, [uri, Object.freeze(list)]);
            void bridge.callMain(
              "languages.diagnostics.set",
              id,
              name,
              uri.toJSON(),
              serialize(list),
            );
          }
          notify([...updates.values()].map(([uri]) => uri));
        },
        delete(uri: Uri) {
          collection.set(uri, undefined);
        },
        clear() {
          ensureActive();
          const uris = [...entries.values()].map(([uri]) => uri);
          entries.clear();
          void bridge.callMain("languages.diagnostics.clear", id);
          notify(uris);
        },
        get(uri: Uri) {
          ensureActive();
          return entries.get(uri.toString())?.[1];
        },
        has(uri: Uri) {
          ensureActive();
          return entries.has(uri.toString());
        },
        forEach(
          callback: (uri: Uri, diagnostics: readonly Diagnostic[], owner: unknown) => unknown,
          thisArg?: unknown,
        ) {
          ensureActive();
          for (const [uri, list] of entries.values()) callback.call(thisArg, uri, list, collection);
        },
        [Symbol.iterator]() {
          ensureActive();
          return entries.values();
        },
        dispose() {
          if (disposed) return;
          collection.clear();
          disposed = true;
          collections.delete(id);
          void bridge.callMain("languages.diagnostics.dispose", id);
        },
      };
      return collection;
    },
    registerCompletionItemProvider(
      selector: unknown,
      provider: Provider,
      ...triggerCharacters: string[]
    ) {
      return register(
        "completion",
        selector,
        provider,
        ["provideCompletionItems", "resolveCompletionItem"],
        triggerCharacters,
      );
    },
    registerHoverProvider(selector: unknown, provider: Provider) {
      return register("hover", selector, provider, ["provideHover"]);
    },
    registerDefinitionProvider(selector: unknown, provider: Provider) {
      return register("definition", selector, provider, ["provideDefinition"]);
    },
    createLanguageStatusItem(id: string, initialSelector: DocumentSelector) {
      const handle = `language-status-${++providerCounter}`;
      const commandHandle = `__lang.status.${handle}`;
      let selector = initialSelector;
      let name = "";
      let text = "";
      let detail = "";
      let severity = 0;
      let busy = false;
      let command: { title: string; command: string; arguments?: unknown[] } | undefined;
      let accessibilityInformation: { label: string; role?: string } | undefined;
      let disposed = false;
      const publish = () => {
        if (disposed) return;
        const document = windowState?.getActiveDocument();
        const icon = busy
          ? "$(sync~spin) "
          : severity === 2
            ? "$(error) "
            : severity === 1
              ? "$(warning) "
              : "";
        void bridge.callMain("statusBar.update", handle, {
          text: icon + text,
          tooltip: [name, detail].filter(Boolean).join("\n"),
          command: command ? commandHandle : null,
          visible: !!document && matchDocument(selector, document) > 0,
        });
      };
      bridge.commandHandlers.set(commandHandle, async () => {
        if (!command) return;
        const callback = bridge.commandHandlers.get(command.command);
        return callback
          ? callback(...(command.arguments ?? []))
          : bridge.callMain("commands.execute", command.command, ...(command.arguments ?? []));
      });
      void bridge.callMain("commands.register", commandHandle);
      void bridge.callMain("statusBar.create", handle, "right", 0);
      const subscription = windowState?.onDidChangeActiveEditor(publish);
      publish();
      return {
        id,
        get name() {
          return name;
        },
        set name(value: string) {
          name = value;
          publish();
        },
        get selector() {
          return selector;
        },
        set selector(value: DocumentSelector) {
          selector = value;
          publish();
        },
        get text() {
          return text;
        },
        set text(value: string) {
          text = value;
          publish();
        },
        get detail() {
          return detail;
        },
        set detail(value: string) {
          detail = value;
          publish();
        },
        get severity() {
          return severity;
        },
        set severity(value: number) {
          severity = value;
          publish();
        },
        get busy() {
          return busy;
        },
        set busy(value: boolean) {
          busy = value;
          publish();
        },
        get command() {
          return command;
        },
        set command(value: typeof command) {
          command = value;
          publish();
        },
        get accessibilityInformation() {
          return accessibilityInformation;
        },
        set accessibilityInformation(value: typeof accessibilityInformation) {
          accessibilityInformation = value;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          subscription?.dispose();
          bridge.commandHandlers.delete(commandHandle);
          void bridge.callMain("commands.unregister", commandHandle);
          void bridge.callMain("statusBar.dispose", handle);
        },
      };
    },
    registerMultiDocumentHighlightProvider(selector: DocumentSelector, provider: Provider) {
      const id = `p-${++providerCounter}`;
      multiHighlightProviders.set(id, { selector, provider });
      return {
        dispose: () => {
          multiHighlightProviders.delete(id);
        },
      };
    },
    registerDocumentPasteEditProvider(
      selector: DocumentSelector,
      provider: Provider,
      metadata: { pasteMimeTypes: readonly string[] },
    ) {
      const id = `p-${++providerCounter}`;
      pasteProviders.set(id, { selector, provider, metadata });
      return {
        dispose: () => {
          pasteProviders.delete(id);
        },
      };
    },
    registerDocumentDropEditProvider(
      selector: DocumentSelector,
      provider: Provider,
      metadata?: { dropMimeTypes: readonly string[] },
    ) {
      const id = `p-${++providerCounter}`;
      dropProviders.set(id, { selector, provider, metadata });
      return {
        dispose: () => {
          dropProviders.delete(id);
        },
      };
    },
    registerCallHierarchyProvider(selector: DocumentSelector, provider: Provider) {
      const id = `p-${++providerCounter}`;
      callHierarchyProviders.set(id, { selector, provider });
      return {
        dispose() {
          callHierarchyProviders.delete(id);
          for (const [key, session] of callHierarchySessions)
            if (session.providerId === id) callHierarchySessions.delete(key);
        },
      };
    },
    registerImplementationProvider(selector: unknown, provider: Provider) {
      return register("implementation", selector, provider, ["provideImplementation"]);
    },
    registerTypeDefinitionProvider(selector: unknown, provider: Provider) {
      return register("typeDefinition", selector, provider, ["provideTypeDefinition"]);
    },
    registerSelectionRangeProvider(selector: unknown, provider: Provider) {
      return register("selectionRange", selector, provider, ["provideSelectionRanges"]);
    },
    registerLinkedEditingRangeProvider(selector: unknown, provider: Provider) {
      return register("linkedEditingRange", selector, provider, ["provideLinkedEditingRanges"]);
    },
    registerOnTypeFormattingEditProvider(
      selector: unknown,
      provider: Provider,
      firstTriggerCharacter: string,
      ...moreTriggerCharacters: string[]
    ) {
      return register(
        "onTypeFormatting",
        selector,
        provider,
        ["provideOnTypeFormattingEdits"],
        [firstTriggerCharacter, ...moreTriggerCharacters],
      );
    },
    registerDocumentSemanticTokensProvider(selector: unknown, provider: Provider, legend: unknown) {
      return register(
        "semanticTokens",
        selector,
        provider,
        ["provideDocumentSemanticTokens", "provideDocumentSemanticTokensEdits"],
        legend,
      );
    },
    registerDocumentRangeSemanticTokensProvider(
      selector: unknown,
      provider: Provider,
      legend: unknown,
    ) {
      return register(
        "rangeSemanticTokens",
        selector,
        provider,
        ["provideDocumentRangeSemanticTokens"],
        legend,
      );
    },
    registerInlineCompletionItemProvider(selector: unknown, provider: Provider) {
      return register("inlineCompletion", selector, provider, ["provideInlineCompletionItems"]);
    },
    registerCodeActionsProvider(selector: unknown, provider: Provider, metadata?: unknown) {
      return register(
        "codeAction",
        selector,
        provider,
        ["provideCodeActions", "resolveCodeAction"],
        metadata,
      );
    },
    registerFoldingRangeProvider(selector: unknown, provider: Provider) {
      return register("folding", selector, provider, ["provideFoldingRanges"]);
    },
    registerDocumentSymbolProvider(selector: unknown, provider: Provider, metadata?: unknown) {
      return register("documentSymbol", selector, provider, ["provideDocumentSymbols"], metadata);
    },
    registerDocumentFormattingEditProvider(selector: unknown, provider: Provider) {
      return register("formatting", selector, provider, ["provideDocumentFormattingEdits"]);
    },
    registerReferenceProvider(selector: unknown, provider: Provider) {
      return register("reference", selector, provider, ["provideReferences"]);
    },
    registerRenameProvider(selector: unknown, provider: Provider) {
      return register("rename", selector, provider, ["provideRenameEdits", "prepareRename"]);
    },
    registerSignatureHelpProvider(
      selector: unknown,
      provider: Provider,
      ...triggersOrMetadata: unknown[]
    ) {
      const metadata =
        typeof triggersOrMetadata[0] === "object"
          ? triggersOrMetadata[0]
          : { triggerCharacters: triggersOrMetadata };
      return register("signatureHelp", selector, provider, ["provideSignatureHelp"], metadata);
    },
    registerDocumentHighlightProvider(selector: unknown, provider: Provider) {
      return register("documentHighlight", selector, provider, ["provideDocumentHighlights"]);
    },
    registerDocumentLinkProvider(selector: unknown, provider: Provider) {
      return register("documentLink", selector, provider, [
        "provideDocumentLinks",
        "resolveDocumentLink",
      ]);
    },
    registerColorProvider(selector: unknown, provider: Provider) {
      return register("color", selector, provider, [
        "provideDocumentColors",
        "provideColorPresentations",
      ]);
    },
    registerInlayHintsProvider(selector: unknown, provider: Provider) {
      return register("inlayHints", selector, provider, ["provideInlayHints", "resolveInlayHint"]);
    },
    registerCodeLensProvider(selector: unknown, provider: Provider) {
      return register("codeLens", selector, provider, ["provideCodeLenses", "resolveCodeLens"]);
    },
    registerDocumentRangeFormattingEditProvider(selector: unknown, provider: Provider) {
      return register("rangeFormatting", selector, provider, [
        "provideDocumentRangeFormattingEdits",
      ]);
    },
  };
}
