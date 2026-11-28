import {
  EventEmitter,
  Uri,
  type CancellationToken,
  type Color,
  type Diagnostic,
  type Position,
  type Range,
  type TextDocumentSnapshot,
  type UriComponents,
} from "@harness/vscode-types";
import type {
  DiagnosticCollection,
  FormattingQuery,
  VscodeLanguagesCompatService,
  SemanticTokensQuery,
} from "@harness/vscode-editor-compat";
import type { LanguageConfigurationSnapshot } from "@harness/vscode-types";

type HoverQueryPosition = Parameters<VscodeLanguagesCompatService["executeHoverProvider"]>[1];

type UriData = {
  scheme?: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
};

interface DiagnosticRegistration {
  readonly values: Map<string, [Uri, readonly Diagnostic[]]>;
  visible?: DiagnosticCollection;
  unmount?: () => void;
}

function isCancellationToken(value: unknown): value is CancellationToken {
  return (
    value !== null &&
    typeof value === "object" &&
    "isCancellationRequested" in value &&
    typeof value.isCancellationRequested === "boolean" &&
    "onCancellationRequested" in value &&
    typeof value.onCancellationRequested === "function"
  );
}

function serializeArgument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serializeArgument);
  if (!value || typeof value !== "object") return value;
  if (isCancellationToken(value)) return { isCancellationRequested: value.isCancellationRequested };
  if ("toJSON" in value && typeof value.toJSON === "function") return value.toJSON();
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, serializeArgument(entry)]),
  );
}

function bindCodeActionEdit(value: unknown, apply: (handle: unknown[]) => Promise<unknown>): void {
  if (!value || typeof value !== "object" || !("_harnessApplyWorkspaceEdit" in value)) return;
  if (!("_harnessCodeAction" in value) || !Array.isArray(value._harnessCodeAction)) return;
  const handle = value._harnessCodeAction;
  Object.defineProperty(value, "applyWorkspaceEdit", { value: () => apply(handle) });
}

export function createMainThreadLanguages(
  languages: VscodeLanguagesCompatService,
  executeCommand: (
    sessionId: string,
    command: string,
    args: unknown[],
    signal?: AbortSignal,
  ) => Promise<unknown>,
  mount: (register: () => () => void) => () => void = (register) => register(),
) {
  const languageConfigurations = new Map<string, () => void>();
  const diagnosticCollections = new Map<string, DiagnosticRegistration>();
  const languageProviders = new Map<string, { dispose(): void; changed: EventEmitter<void> }>();

  const handle = (sessionId: string, method: string, args: unknown[]) => {
    if (method === "languages.executeLinkProvider") {
      const [resource, count, snapshot] = args as [UriComponents, number, TextDocumentSnapshot?];
      return languages.executeLinkProvider(Uri.from(resource), count, snapshot);
    }
    if (method === "languages.executeSelectionRangeProvider") {
      const [resource, positions, snapshot] = args as [
        UriComponents,
        Position[],
        TextDocumentSnapshot?,
      ];
      return languages.executeSelectionRangeProvider(Uri.from(resource), positions, snapshot);
    }
    if (method === "languages.getLanguages") return languages.getLanguages();
    if (method === "languages.executeFormattingProvider") {
      const [resource, query, snapshot] = args as [
        UriComponents,
        FormattingQuery,
        TextDocumentSnapshot,
      ];
      return languages.executeFormattingProvider(Uri.from(resource), query, snapshot);
    }
    if (method === "languages.executeDefinitionProvider") {
      const [kind, resource, position, snapshot] = args as [
        Parameters<VscodeLanguagesCompatService["executeDefinitionProvider"]>[0],
        UriComponents,
        Position,
        TextDocumentSnapshot?,
      ];
      return languages.executeDefinitionProvider(kind, Uri.from(resource), position, snapshot);
    }
    if (method === "languages.executeDocumentSymbolProvider") {
      const [resource, snapshot] = args as [UriComponents, TextDocumentSnapshot?];
      return languages.executeDocumentSymbolProvider(Uri.from(resource), snapshot);
    }
    if (method === "languages.executeDocumentColorProvider")
      return languages.executeDocumentColorProvider(Uri.from(args[0] as UriComponents));
    if (method === "languages.executeColorPresentationProvider") {
      const [color, { uri, range }] = args as [Color, { uri: UriComponents; range: Range }];
      return languages.executeColorPresentationProvider(color, { uri: Uri.from(uri), range });
    }
    if (method === "languages.provideSemanticTokens") {
      const [resource, query, snapshot] = args as [
        UriComponents,
        SemanticTokensQuery,
        TextDocumentSnapshot,
      ];
      return languages.provideSemanticTokens(Uri.from(resource), query, snapshot);
    }
    if (method === "languages.executeHoverProvider") {
      const [uri, position, snapshot] = args as [
        UriComponents,
        HoverQueryPosition,
        TextDocumentSnapshot?,
      ];
      return languages.executeHoverProvider(Uri.from(uri), position, snapshot);
    }
    if (method === "languages.registerProvider") {
      const [kind, id, selector, metadata, methods] = args as [
        string,
        string,
        Parameters<VscodeLanguagesCompatService["registerHoverProvider"]>[0],
        unknown,
        string[],
      ];
      const key = `${sessionId}:${id}`;
      languageProviders.get(key)?.dispose();
      const changed = new EventEmitter<void>();
      const provider: Record<string, unknown> = {
        onDidChangeCodeLenses: changed.event,
        onDidChangeInlayHints: changed.event,
        onDidChangeFoldingRanges: changed.event,
        onDidChangeSemanticTokens: changed.event,
      };
      for (const name of methods) {
        provider[name] = async (...parameters: unknown[]) => {
          const token = parameters.find(isCancellationToken);
          if (token?.isCancellationRequested) return undefined;
          const controller = token ? new AbortController() : undefined;
          const subscription = token?.onCancellationRequested(() => controller?.abort());
          let result: unknown;
          try {
            result = await executeCommand(
              sessionId,
              `__lang.provide.${id}`,
              [name, ...parameters.map(serializeArgument)],
              controller?.signal,
            );
          } catch (error) {
            if (controller?.signal.aborted) return undefined;
            throw error;
          } finally {
            subscription?.dispose();
          }
          const applyCodeAction = (handle: unknown[]) =>
            executeCommand(sessionId, `__lang.applyCodeAction.${id}`, handle);
          if (name === "resolveCodeAction") bindCodeActionEdit(result, applyCodeAction);
          if (
            name === "provideCompletionItems" &&
            result &&
            typeof result === "object" &&
            "_harnessCompletionList" in result
          ) {
            const listId = result._harnessCompletionList;
            return Object.assign(result, {
              dispose() {
                void executeCommand(sessionId, `__lang.releaseCompletion.${id}`, [listId]).catch(
                  (error: unknown) => console.error(error),
                );
              },
            });
          }
          const listType =
            name === "provideCodeLenses"
              ? "CodeLens"
              : name === "provideDocumentLinks"
                ? "DocumentLink"
                : name === "provideCodeActions"
                  ? "CodeAction"
                  : name === "provideInlayHints"
                    ? "InlayHint"
                    : undefined;
          if (
            listType &&
            result &&
            typeof result === "object" &&
            "items" in result &&
            Array.isArray(result.items)
          ) {
            const listId = (result as Record<string, unknown>)[`_harness${listType}List`];
            if (listType === "CodeAction")
              for (const action of result.items) bindCodeActionEdit(action, applyCodeAction);
            return Object.defineProperty(result.items, "dispose", {
              value() {
                void executeCommand(sessionId, `__lang.release${listType}.${id}`, [listId]).catch(
                  (error: unknown) => console.error(error),
                );
              },
            });
          }
          return result;
        };
      }
      const unmount = mount(() => {
        let registration: { dispose(): void };
        switch (kind) {
          case "completion":
            registration = languages.registerCompletionItemProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerCompletionItemProvider>[1],
              ...((metadata as string[]) ?? []),
            );
            break;
          case "hover":
            registration = languages.registerHoverProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerHoverProvider>[1],
            );
            break;
          case "definition":
            registration = languages.registerDefinitionProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerDefinitionProvider>[1],
            );
            break;
          case "implementation":
            registration = languages.registerImplementationProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerImplementationProvider>[1],
            );
            break;
          case "typeDefinition":
            registration = languages.registerTypeDefinitionProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerTypeDefinitionProvider>[1],
            );
            break;
          case "selectionRange":
            registration = languages.registerSelectionRangeProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerSelectionRangeProvider>[1],
            );
            break;
          case "linkedEditingRange":
            registration = languages.registerLinkedEditingRangeProvider(
              selector,
              provider as unknown as Parameters<
                typeof languages.registerLinkedEditingRangeProvider
              >[1],
            );
            break;
          case "onTypeFormatting": {
            const triggers = metadata as string[];
            registration = languages.registerOnTypeFormattingEditProvider(
              selector,
              provider as unknown as Parameters<
                typeof languages.registerOnTypeFormattingEditProvider
              >[1],
              triggers[0]!,
              ...triggers.slice(1),
            );
            break;
          }
          case "semanticTokens":
            registration = languages.registerDocumentSemanticTokensProvider(
              selector,
              provider as unknown as Parameters<
                typeof languages.registerDocumentSemanticTokensProvider
              >[1],
              metadata as Parameters<typeof languages.registerDocumentSemanticTokensProvider>[2],
            );
            break;
          case "rangeSemanticTokens":
            registration = languages.registerDocumentRangeSemanticTokensProvider(
              selector,
              provider as unknown as Parameters<
                typeof languages.registerDocumentRangeSemanticTokensProvider
              >[1],
              metadata as Parameters<
                typeof languages.registerDocumentRangeSemanticTokensProvider
              >[2],
            );
            break;
          case "inlineCompletion":
            registration = languages.registerInlineCompletionItemProvider(
              selector,
              provider as unknown as Parameters<
                typeof languages.registerInlineCompletionItemProvider
              >[1],
            );
            break;
          case "codeAction":
            registration = languages.registerCodeActionsProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerCodeActionsProvider>[1],
              metadata as Parameters<typeof languages.registerCodeActionsProvider>[2],
            );
            break;
          case "folding":
            registration = languages.registerFoldingRangeProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerFoldingRangeProvider>[1],
            );
            break;
          case "documentSymbol":
            registration = languages.registerDocumentSymbolProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerDocumentSymbolProvider>[1],
              metadata as Parameters<typeof languages.registerDocumentSymbolProvider>[2],
            );
            break;
          case "formatting":
            registration = languages.registerDocumentFormattingEditProvider(
              selector,
              provider as unknown as Parameters<
                typeof languages.registerDocumentFormattingEditProvider
              >[1],
            );
            break;
          case "reference":
            registration = languages.registerReferenceProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerReferenceProvider>[1],
            );
            break;
          case "rename":
            registration = languages.registerRenameProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerRenameProvider>[1],
            );
            break;
          case "signatureHelp": {
            const options = metadata as {
              triggerCharacters?: string[];
              retriggerCharacters?: string[];
            };
            registration = languages.registerSignatureHelpProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerSignatureHelpProvider>[1],
              options,
            );
            break;
          }
          case "documentHighlight":
            registration = languages.registerDocumentHighlightProvider(
              selector,
              provider as unknown as Parameters<
                typeof languages.registerDocumentHighlightProvider
              >[1],
            );
            break;
          case "documentLink":
            registration = languages.registerDocumentLinkProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerDocumentLinkProvider>[1],
            );
            break;
          case "color":
            registration = languages.registerColorProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerColorProvider>[1],
            );
            break;
          case "inlayHints":
            registration = languages.registerInlayHintsProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerInlayHintsProvider>[1],
            );
            break;
          case "codeLens":
            registration = languages.registerCodeLensProvider(
              selector,
              provider as unknown as Parameters<typeof languages.registerCodeLensProvider>[1],
            );
            break;
          case "rangeFormatting":
            registration = languages.registerDocumentRangeFormattingEditProvider(
              selector,
              provider as unknown as Parameters<
                typeof languages.registerDocumentRangeFormattingEditProvider
              >[1],
            );
            break;
          default:
            changed.dispose();
            throw new Error(`Unknown language provider kind: ${kind}`);
        }
        return () => registration.dispose();
      });
      languageProviders.set(key, {
        changed,
        dispose() {
          unmount();
          changed.dispose();
        },
      });
      return;
    }
    if (method === "languages.executeSignatureHelpProvider") {
      const [resource, position, triggerCharacter, snapshot] = args as [
        UriComponents,
        Position,
        string | null,
        TextDocumentSnapshot,
      ];
      return languages.executeSignatureHelpProvider(
        Uri.from(resource),
        position,
        triggerCharacter ?? undefined,
        snapshot,
      );
    }
    if (method === "languages.providerChanged") {
      languageProviders.get(`${sessionId}:${String(args[0])}`)?.changed.fire();
      return;
    }
    if (method === "languages.unregisterProvider") {
      const key = `${sessionId}:${String(args[0])}`;
      languageProviders.get(key)?.dispose();
      languageProviders.delete(key);
      return;
    }
    if (method === "languages.setLanguageConfiguration") {
      const [id, language, configuration] = args as [string, string, LanguageConfigurationSnapshot];
      const key = `${sessionId}:${id}`;
      languageConfigurations.get(key)?.();
      const unregister = mount(() => {
        const registration = languages.setLanguageConfiguration(language, configuration);
        return () => registration?.dispose();
      });
      languageConfigurations.set(key, unregister);
      return;
    }
    if (method === "languages.disposeLanguageConfiguration") {
      const key = `${sessionId}:${String(args[0])}`;
      languageConfigurations.get(key)?.();
      languageConfigurations.delete(key);
      return;
    }
    if (method.startsWith("languages.diagnostics.")) {
      const key = `${sessionId}:${String(args[0])}`;
      let collection = diagnosticCollections.get(key);
      if (method === "languages.diagnostics.set") {
        const [, name, rawUri, diagnostics] = args as [
          string,
          string,
          UriData,
          readonly Diagnostic[] | undefined,
        ];
        if (!collection) {
          const entry: DiagnosticRegistration = { values: new Map() };
          entry.unmount = mount(() => {
            const visible = languages.createDiagnosticCollection(name);
            entry.visible = visible;
            visible.set([...entry.values.values()]);
            return () => {
              entry.visible = undefined;
              visible.dispose();
            };
          });
          diagnosticCollections.set(key, entry);
          collection = entry;
        }
        const uri = Uri.from({ ...rawUri, scheme: rawUri.scheme ?? "file" });
        if (diagnostics) collection.values.set(uri.toString(), [uri, diagnostics]);
        else collection.values.delete(uri.toString());
        collection.visible?.set(uri, diagnostics ?? undefined);
      } else if (method === "languages.diagnostics.clear") {
        collection?.values.clear();
        collection?.visible?.clear();
      } else if (method === "languages.diagnostics.dispose") {
        collection?.unmount?.();
        diagnosticCollections.delete(key);
      } else {
        throw new Error(`Unknown language bridge call: ${method}`);
      }
      return;
    }
    throw new Error(`Unknown language bridge call: ${method}`);
  };
  return Object.assign(handle, {
    dispose() {
      for (const unregister of languageConfigurations.values()) unregister();
      languageConfigurations.clear();
      for (const provider of languageProviders.values()) provider.dispose();
      languageProviders.clear();
      for (const collection of diagnosticCollections.values()) collection.unmount?.();
      diagnosticCollections.clear();
    },
  });
}
