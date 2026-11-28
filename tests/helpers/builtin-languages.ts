import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "./extension-host.ts";
import { createMainThreadTree } from "../../packages/vscode-ext-host/src/main-thread/tree.ts";
import { createMainThreadLanguages } from "../../packages/vscode-ext-host/src/main-thread/languages.ts";

export type BuiltinLanguageProvider = Record<string, (...args: unknown[]) => Promise<unknown>>;
export type BuiltinLanguageRegistration = {
  kind: string;
  selector: unknown;
  provider: BuiltinLanguageProvider;
  metadata: unknown[];
};

export async function createBuiltinLanguageHost(
  root: string,
  additionalMainCall?: (
    session: string,
    method: string,
    args: unknown[],
  ) => Promise<{ handled: boolean; result?: unknown }>,
  databasePath?: string,
) {
  const fixture = await createExtensionHostFixture(databasePath);
  const host = fixture.service;
  const tree = createMainThreadTree();
  const registrations: BuiltinLanguageRegistration[] = [];
  const diagnostics = new Map<string, unknown[]>();
  const errors: string[] = [];
  const commands = new Set<string>();
  const contexts = new Map<string, unknown>();
  const status = new Map<string, Record<string, unknown>>();
  const outputs = new Map<string, string>();
  const visibleOutputs = new Set<string>();
  const taskProviders = new Set<string>();
  const customEditors = new Set<string>();
  const decorationTypes = new Map<string, unknown>();
  const decorations = new Map<string, unknown[]>();
  const progress = new Map<string, { title: unknown; messages: unknown[] }>();
  const mementos = new Map<string, Record<string, unknown>>();
  const kinds = [
    "CompletionItem",
    "Hover",
    "Definition",
    "InlineCompletionItem",
    "Reference",
    "Rename",
    "CodeActions",
    "Color",
    "SignatureHelp",
    "CodeLens",
    "FoldingRange",
    "DocumentSymbol",
    "DocumentFormattingEdit",
    "DocumentRangeFormattingEdit",
    "DocumentHighlight",
    "DocumentLink",
    "InlayHints",
    "Implementation",
    "TypeDefinition",
    "SelectionRange",
    "LinkedEditingRange",
    "OnTypeFormattingEdit",
    "DocumentRangeSemanticTokens",
    "DocumentSemanticTokens",
  ];
  const service = {
    ...Object.fromEntries(
      kinds.map((kind) => [
        `register${kind}Provider`,
        (selector: unknown, provider: BuiltinLanguageProvider, ...metadata: unknown[]) => {
          const registration = { kind, selector, provider, metadata };
          registrations.push(registration);
          return {
            dispose() {
              registrations.splice(registrations.indexOf(registration), 1);
            },
          };
        },
      ]),
    ),
    createDiagnosticCollection(name: string) {
      const owned = new Set<string>();
      return {
        set(uri: Uri, values?: unknown[]) {
          const key = `${name}:${uri.toString()}`;
          owned.add(key);
          if (values === undefined) diagnostics.delete(key);
          else diagnostics.set(key, values);
        },
        clear() {
          for (const key of owned) diagnostics.delete(key);
          owned.clear();
        },
        dispose() {
          this.clear();
        },
      };
    },
  };
  const languages = createMainThreadLanguages(service as never, (session, command, args) =>
    host.executeCommand(session, command, ...args),
  );
  const off = host.onMainThreadCall(async (session, method, args, requestId) => {
    appendFileSync(join(root, "main-thread-calls.jsonl"), JSON.stringify({ method, args }) + "\n");
    try {
      let result: unknown;
      const additional = await additionalMainCall?.(session, method, args);
      if (additional?.handled) result = additional.result;
      else if (method === "workspace.resolveDocumentLanguage") result = "plaintext";
      else if (method.startsWith("languages.")) result = await languages(session, method, args);
      else if (method.startsWith("tree.")) {
        if (!tree.handle(method, args)) throw new Error(`Unsupported tree call: ${method}`);
      } else if (method === "memento.load") result = mementos.get(JSON.stringify(args)) ?? {};
      else if (method === "memento.update") {
        const key = JSON.stringify(args.slice(0, 2));
        const state = { ...mementos.get(key), [String(args[2])]: args[3] };
        if (args[4]) delete state[String(args[2])];
        mementos.set(key, state);
        writeFileSync(join(root, "mementos.json"), JSON.stringify([...mementos]));
      } else if (method === "commands.register") commands.add(String(args[0]));
      else if (method === "commands.unregister") commands.delete(String(args[0]));
      else if (method === "commands.getCommands") result = [...commands];
      else if (method === "commands.execute" && args[0] === "setContext")
        contexts.set(String(args[1]), args[2]);
      else if (method === "output.create") {
        const output = join(root, `output-${outputs.size}.log`);
        outputs.set(String(args[0]), output);
        writeFileSync(output, "");
      } else if (method === "output.append" || method === "output.appendLine") {
        const output = outputs.get(String(args[0]));
        if (!output) throw new Error(`Unknown output: ${args[0]}`);
        appendFileSync(output, String(args[1]) + (method.endsWith("Line") ? "\n" : ""));
      } else if (method === "output.replace")
        writeFileSync(outputs.get(String(args[0]))!, String(args[1]));
      else if (method === "output.clear") writeFileSync(outputs.get(String(args[0]))!, "");
      else if (method === "output.dispose") {
        outputs.delete(String(args[0]));
        visibleOutputs.delete(String(args[0]));
      } else if (method === "output.show") {
        if (!outputs.has(String(args[0]))) throw new Error(`Unknown output: ${args[0]}`);
        visibleOutputs.add(String(args[0]));
      } else if (method === "output.hide") visibleOutputs.delete(String(args[0]));
      else if (method === "auth.unregisterSession") result = undefined;
      else if (method === "window.showMessage") {
        appendFileSync(join(root, "messages.jsonl"), JSON.stringify(args) + "\n");
        if (args[0] === "error") throw new Error(`Extension reported error: ${args[1]}`);
        result = undefined;
      } else if (method === "statusBar.create") status.set(String(args[0]), {});
      else if (method === "statusBar.update") {
        const current = status.get(String(args[0]));
        if (!current) throw new Error(`Unknown status: ${args[0]}`);
        Object.assign(current, args[1]);
      } else if (method === "statusBar.dispose") status.delete(String(args[0]));
      else if (method === "window.progressStart")
        progress.set(String(args[0]), { title: args[1], messages: [] });
      else if (method === "window.progressReport") {
        const current = progress.get(String(args[0]));
        if (!current) throw new Error(`Unknown progress: ${args[0]}`);
        current.messages.push(args.slice(1));
      } else if (method === "window.progressEnd") {
        appendFileSync(
          join(root, "progress.jsonl"),
          JSON.stringify(progress.get(String(args[0]))) + "\n",
        );
        progress.delete(String(args[0]));
      } else if (method === "window.createDecorationType")
        decorationTypes.set(String(args[0]), args[1]);
      else if (method === "window.disposeDecorationType") {
        decorationTypes.delete(String(args[0]));
        decorations.delete(String(args[0]));
      } else if (method === "editor.setDecorations") {
        if (!decorationTypes.has(String(args[0])))
          throw new Error(`Unknown decoration: ${args[0]}`);
        decorations.set(String(args[0]), args[1] as unknown[]);
      } else if (method === "window.registerCustomEditorProvider")
        customEditors.add(String(args[0]));
      else if (method === "window.unregisterCustomEditorProvider")
        customEditors.delete(String(args[0]));
      else if (method === "tasks.registerProvider") taskProviders.add(String(args[0]));
      else if (method === "tasks.unregisterProvider") taskProviders.delete(String(args[0]));
      else throw new Error(`Unsupported main-thread call: ${method} ${JSON.stringify(args)}`);
      if (requestId) host.resolveMainCall(requestId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      appendFileSync(join(root, "errors.log"), message + "\n");
      if (requestId) host.resolveMainCall(requestId, undefined, message);
    }
  });
  return {
    host,
    scope: fixture.scope,
    modules: fixture.modules,
    registrations,
    diagnostics,
    errors,
    status,
    commands,
    contexts,
    outputs,
    customEditors,
    decorationTypes,
    decorations,
    tree,
    async dispose(session: string) {
      try {
        await fixture.dispose(session);
      } finally {
        off();
      }
    },
  };
}
