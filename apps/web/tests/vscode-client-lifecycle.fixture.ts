import { computed, effectScope, reactive, ref } from "vue";
import {
  InstantiationService,
  runInInjectionContext,
} from "../../../packages/di/src/instantiation.ts";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { RpcClientService } from "@harness/rpc";
import { StateSyncClientService } from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { UiCommandsService } from "@harness/ui-commands";
import { UiConfigService } from "@harness/ui-config";
import { UiFilePickerService } from "@harness/ui-file-picker";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiOutputService } from "@harness/ui-output";
import { UiQuickInputService } from "@harness/ui-quick-input";
import { UiScmService } from "@harness/ui-scm";
import { UiSessionsService } from "@harness/ui-sessions";
import { UiStatusBarService } from "@harness/ui-status-bar";
import { UiStorageService } from "@harness/ui-storage";
import { UiTerminalService } from "@harness/ui-terminal";
import { UiWebviewService } from "@harness/ui-webview";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import {
  VscodeEnvCompatService,
  VscodeLanguagesCompatService,
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { activeContributions } from "@harness/vscode-editor-compat/contribution-state";
import { EventEmitter, TextDocumentData, Uri } from "../../../packages/vscode-types/src/index.ts";

const bridge = window as typeof window & {
  lifecycleRpc(method: string, args: Record<string, unknown>): Promise<unknown>;
  lifecycleEvents(sessionId: string): Promise<unknown[]>;
};
const session = ref<{ id: string; workspaceId: string }>();
const configuredColorTheme = ref<string>();
const documentOpen = new EventEmitter<TextDocumentData>();
const unused = new EventEmitter<never>();
const documents = ref<TextDocumentData[]>([]);
const tabs = reactive(new Map<string, { tabId: string; descriptor: unknown; title: string }>());
const storage = new Map<string, unknown>();
const messages: string[] = [];
const decorations = new Map<string, unknown>();
const scope = effectScope();
let client: ExtensionHostClientService;
let commands: UiCommandsService;
export function start(root: string) {
  const workspace = {
    textDocuments: documents,
    workspaceFolders: ref([{ uri: Uri.file(root), name: "fixture", index: 0 }]),
    onDidOpenTextDocument: documentOpen.event,
    onDidCloseTextDocument: unused.event,
    onDidSaveTextDocument: unused.event,
    onDidChangeTextDocument: unused.event,
    onDidChangeWorkspaceFolders: unused.event,
  };
  documents.value = [
    new TextDocumentData({
      uri: Uri.file(root + "/first/initial.fixture"),
      text: "initial",
      languageId: "fixture",
      version: 1,
      eol: 1,
      isDirty: false,
    }),
  ];
  scope.run(() => {
    commands = new UiCommandsService();
    const services = new Map<unknown, unknown>([
      [
        RpcClientService,
        {
          use: () =>
            new Proxy(
              {},
              {
                get: (_, method) => (input: Record<string, unknown>) =>
                  bridge.lifecycleRpc(String(method), input),
              },
            ),
        },
      ],
      [
        StreamClientService,
        {
          use: () => ({
            async *events(input: { sessionId: string }, signal: AbortSignal) {
              const { sessionId } = input;
              yield { ready: true };
              while (!signal.aborted) {
                const events = await bridge.lifecycleEvents(sessionId);
                for (const event of events) if (!signal.aborted) yield event;
              }
            },
          }),
        },
      ],
      [UiSessionsService, { current: session }],
      [
        UiWorkspaceService,
        {
          activeRoots: computed(() => [`${root}/${session.value?.workspaceId ?? "first"}`]),
          getRoot: (path: string) => ({
            readFile: async (relative: string) => ({ content: `${path}/${relative}` }),
          }),
          onFileChange: () => () => {},
        },
      ],
      [UiCommandsService, commands],
      [
        UiTabsService,
        {
          tabs,
          groups: ref([]),
          open(descriptor: { key: string; title: string }) {
            tabs.set(descriptor.key, {
              tabId: descriptor.key,
              descriptor,
              title: descriptor.title,
            });
          },
          close(id: string) {
            tabs.delete(id);
          },
        },
      ],
      [StateSyncClientService, { use: () => ({ contributionsVersion: ref("fixture") }) }],
      [UiWorkbenchService, { theme: ref("dark"), open() {} }],
      [
        UiConfigService,
        {
          snapshot: () => ({ defaults: {}, user: {}, workspace: {} }),
          get: (key: string, fallback: unknown) =>
            key === "workbench.colorTheme" ? (configuredColorTheme.value ?? fallback) : fallback,
          useDefaults() {},
        },
      ],
      [
        UiNotificationService,
        {
          notify(message: string) {
            messages.push(message);
          },
          async showMessage({ message }: { message: string }) {
            messages.push(message);
          },
        },
      ],
      [UiScmService, { registerProviderSource: () => () => {} }],
      [UiOutputService, new UiOutputService()],
      [UiStatusBarService, new UiStatusBarService()],
      [UiQuickInputService, new UiQuickInputService()],
      [
        UiFilePickerService,
        { pickOpen: async () => undefined, pickSavePath: async () => undefined },
      ],
      [
        UiStorageService,
        {
          scope: (...path: string[]) => ({
            use(id: string, fields: Record<string, { parse(value: undefined): unknown }>) {
              const key = JSON.stringify([...path, id]);
              if (!storage.has(key))
                storage.set(
                  key,
                  reactive(
                    Object.fromEntries(
                      Object.entries(fields).map(([name, field]) => [name, field.parse(undefined)]),
                    ),
                  ),
                );
              return storage.get(key);
            },
          }),
        },
      ],
      [UiWebviewService, new UiWebviewService()],
      [UiTerminalService, { onDidExit: unused.event, kill: async () => {} }],
      [VscodeWorkspaceCompatService, workspace],
      [
        VscodeWindowCompatService,
        {
          async showTextDocument(uri: Uri) {
            const doc = documents.value.find(
              (document) => document.uri.toString() === uri.toString(),
            );
            if (!doc) throw new Error(`Missing fixture document: ${uri.toString()}`);
            return {
              document: doc,
              selections: [],
              visibleRanges: [],
              viewColumn: 1,
              options: { tabSize: 2, insertSpaces: true },
            };
          },
          createTextEditorDecorationType(options: unknown) {
            const key = crypto.randomUUID();
            decorations.set(key, options);
            return {
              key,
              dispose() {
                decorations.delete(key);
              },
            };
          },
          activeTextEditor: ref(),
          visibleTextEditors: ref([]),
          tabGroupsSnapshot: ref({ groups: [] }),
          windowState: ref({ focused: true, active: true }),
          onDidChangeActiveTextEditor: unused.event,
          onDidChangeVisibleTextEditors: unused.event,
          onDidChangeTextEditorSelection: unused.event,
          onDidChangeTextEditorOptions: unused.event,
          onDidChangeTextEditorVisibleRanges: unused.event,
        },
      ],
      [VscodeEnvCompatService, { language: "en" }],
    ]);
    const injector = {
      get<T>(id: abstract new (...args: any[]) => T): T {
        if (!services.has(id)) throw new Error(`Missing client fixture service ${id.name}`);
        return services.get(id) as T;
      },
    };
    services.set(InstantiationService, {
      createInstance: <T>(ctor: new (...args: any[]) => T, ...args: any[]) =>
        runInInjectionContext(injector, () => new ctor(...args)),
    });
    runInInjectionContext(injector, () => {
      services.set(VscodeLanguagesCompatService, new VscodeLanguagesCompatService());
      client = new ExtensionHostClientService();
    });
  });
}
export function snapshot() {
  return {
    commands: commands.commands.value.map((item) => item.id),
    panels: [...client.webviewPanels.keys()],
    tree: [...client.treeViews.keys()],
    colorTheme: activeContributions.value?.colorTheme?.id,
    tabs: [...tabs.keys()],
    messages: [...messages],
  };
}
export function setColorTheme(id: string) {
  configuredColorTheme.value = id;
}
export function select(id?: string) {
  session.value = id ? { id, workspaceId: id } : undefined;
}
export function openLanguage(root: string, languageId: string) {
  const doc = new TextDocumentData({
    uri: Uri.file(root + "/first/later." + languageId),
    text: "later",
    languageId,
    version: 1,
    eol: 1,
    isDirty: false,
  });
  documents.value.push(doc);
  documentOpen.fire(doc);
}
export async function execute(command: string) {
  return commands.execute(command);
}
export function post(id: string) {
  client.postWebviewMessage(id, { old: true });
}
export function dispose() {
  scope.stop();
}
