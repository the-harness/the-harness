import { readConfigurationDefaults } from "./configuration-defaults.ts";
import { createRequire, registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { createVscodeApi } from "./vscode/index.ts";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionManifest } from "./manifest.ts";
import { workspaceContains } from "./node/workspace-contains.ts";
import type { ExtHostBridge } from "./vscode/bridge.ts";
import { createMemento } from "./vscode/memento.ts";
import type { EnvironmentEdit, EnvironmentUpdate } from "./environment-edits.ts";
import { createEnvironmentCollection } from "./vscode/environment-collection.ts";
import {
  createLocalization,
  loadLocalizationBundle,
  type LocalizationBundle,
} from "./vscode/localization.ts";
import { EventEmitter, ExtensionMode, Uri } from "./vscode/types.ts";
import type { IpcMessage, RpcRequest, RpcResponse } from "./ipc.ts";
import { decodeExtHostError, encodeExtHostError } from "./wire-error.ts";

const require = createRequire(import.meta.url);
const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const rejectionTimers = new WeakMap<Promise<unknown>, ReturnType<typeof setTimeout>>();
process.on("unhandledRejection", (_reason, promise) => {
  // Extensions can attach a handler after Node emits the initial rejection event.
  const timer = setTimeout(() => {
    rejectionTimers.delete(promise);
    void promise.catch((error: unknown) => {
      if (error instanceof Error && error.name === "Canceled" && error.message === "Canceled")
        return;
      console.error("Unhandled rejection in the VS Code extension host", error);
    });
  }, 1000);
  timer.unref();
  rejectionTimers.set(promise, timer);
});
process.on("rejectionHandled", (promise) => {
  clearTimeout(rejectionTimers.get(promise));
  rejectionTimers.delete(promise);
});
process.on("uncaughtException", (error, origin) => {
  if (origin === "unhandledRejection") return;
  const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException;
  if (code === "EPIPE" && typeof syscall === "string" && syscall.toUpperCase() === "WRITE") return;
  console.error("Uncaught exception in the VS Code extension host", error);
});

let hooksInstalled = false;
function ensureVscodeHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "vscode") {
        const owner = extensionForSource(context.parentURL) ?? extensionOwner.getStore();
        return { url: `vscode:api/${encodeURIComponent(owner ?? "")}`, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("vscode:api/")) {
        return {
          format: "module",
          source:
            `const api = globalThis.__HARNESS_VSCODE_API_FOR_EXTENSION__(${JSON.stringify(decodeURIComponent(url.slice("vscode:api/".length)))}); export default api;\n` +
            Object.keys(vscodeApi)
              .map((key) => `export const ${key} = api[${JSON.stringify(key)}];`)
              .join("\n"),
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
}

let nextReqId = 1;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (err: Error) => void }
>();
const requests = new Map<number, AbortController>();
const requestContext = new AsyncLocalStorage<{
  signal: AbortSignal;
  release?: RpcResponse["release"];
}>();
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
const manifests = new Map<string, ExtensionManifest>();
const activatedExtensions = new Map<
  string,
  { exports?: unknown; subscriptions: { dispose(): unknown }[]; deactivate?: () => unknown }
>();
const activatingExtensions = new Map<string, Promise<unknown>>();
let extensionSync = Promise.resolve();
let workspaceRoots: string[] = [];
let workspaceContainsScan: AbortController | undefined;
let storageRoot = process.env.HARNESS_VSCODE_DATA_DIR ?? path.join(homedir(), ".harness", "vscode");
const environmentCollections = new Map<string, ReturnType<typeof createEnvironmentCollection>>();
let environmentWrites: Promise<unknown> = Promise.resolve();
let pendingEnvironments: EnvironmentUpdate[] | undefined;
let environmentWriteFailure: { error: unknown } | undefined;

function saveEnvironment(file: string, edit: EnvironmentEdit, legacy?: string): void {
  if (environmentWriteFailure) throw environmentWriteFailure.error;
  if (!pendingEnvironments) {
    const batch: EnvironmentUpdate[] = [];
    pendingEnvironments = batch;
    environmentWrites = environmentWrites.then(() => {
      pendingEnvironments = undefined;
      return callMain("environment.save", batch);
    });
    void environmentWrites.catch((error: unknown) => {
      if (environmentWriteFailure) return;
      environmentWriteFailure = { error };
      pendingEnvironments = undefined;
      console.error(error);
    });
  }
  pendingEnvironments.push({ file, edit: structuredClone(edit), legacy });
}

const secretChanges = new Map<string, EventEmitter<{ key: string }>>();
commandHandlers.set("__secrets.onDidChange", (extensionId, key) => {
  if (typeof extensionId === "string" && typeof key === "string") {
    secretChanges.get(extensionId)?.fire({ key });
  }
});

function callMain(method: string, ...args: unknown[]): Promise<unknown> {
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (!process.send || !process.connected) {
      pending.delete(id);
      reject(new Error("Extension host disconnected"));
      return;
    }
    process.send({ type: "request", id, method, args } satisfies RpcRequest, (error) => {
      if (!error) return;
      pending.delete(id);
      reject(error);
    });
  });
}

const bridge: ExtHostBridge = {
  callMain,
  getRequestSignal: () => requestContext.getStore()?.signal,
  releaseDroppedResponse(command, listId) {
    const request = requestContext.getStore();
    if (request) request.release = { command, listId };
  },
  getWorkspaceRoots: () => workspaceRoots,
  getExtensionPath: () => extensionOwner.getStore(),
  getExtensionId() {
    const owner = extensionOwner.getStore();
    if (!owner) return undefined;
    return [...manifests.values()].find((manifest) => manifest.extensionPath === owner)?.id;
  },
  getTerminalEnvironment: (env, cwd) => {
    const result: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) result[key] = value;
    Object.assign(result, env);
    for (const collection of environmentCollections.values()) collection.apply(result, cwd);
    return Object.fromEntries(
      Object.entries(result).filter(
        ([key, value]) => Object.hasOwn(env ?? {}, key) || value !== process.env[key],
      ),
    );
  },
  commandHandlers,
  activateExtension,
  activateByEvent: (event) => activateByEvent(event, true),
};
const extensionOwner = new AsyncLocalStorage<string>();
const activationChain = new AsyncLocalStorage<readonly string[]>();
const extensionApis = new Map<string, ReturnType<typeof createVscodeApi>>();
const localizationBundles = new Map<string, LocalizationBundle>();
function extensionForSource(source?: string): string | undefined {
  if (!source) return undefined;
  const file = source.startsWith("file:") ? fileURLToPath(source) : source;
  return [...manifests.values()]
    .map((manifest) => manifest.extensionPath)
    .sort((a, b) => b.length - a.length)
    .find((root) => {
      const relative = path.relative(root, file);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    });
}
const vscodeApi = createVscodeApi(bridge);
vscodeApi.workspace.onDidChangeWorkspaceFolders(() => {
  workspaceRoots = (vscodeApi.workspace.workspaceFolders ?? [])
    .filter(({ uri }) => uri.scheme === "file")
    .map(({ uri }) => uri.fsPath);
  activateWorkspaceContainsExtensions();
});

function activateWorkspaceContainsExtensions(): void {
  workspaceContainsScan?.abort();
  if (!workspaceRoots.length) return;

  const scan = new AbortController();
  workspaceContainsScan = scan;
  const roots = workspaceRoots;
  const prefix = "workspaceContains:";
  const configuration = vscodeApi.workspace.getConfiguration();
  for (const [key, manifest] of manifests) {
    if (activatedExtensions.has(key)) continue;
    const patterns = manifest.activationEvents
      .filter((event) => event.startsWith(prefix) && event.length > prefix.length)
      .map((event) => event.slice(prefix.length));
    if (!patterns.length) continue;

    void workspaceContains(roots, patterns, configuration, scan.signal)
      .then(async (matched) => {
        if (matched && !scan.signal.aborted && manifests.get(key) === manifest)
          await activateExtension(key);
      })
      .catch((error: unknown) => {
        if (!scan.signal.aborted) console.error(error);
      });
  }
}

function apiForExtension(owner?: string): typeof vscodeApi {
  if (!owner) return vscodeApi;
  let api = extensionApis.get(owner);
  if (!api) {
    api = { ...vscodeApi, l10n: createLocalization(() => localizationBundles.get(owner)) };
    for (const namespace of ["window", "chat", "comments"] as const) {
      const methods = new Map<PropertyKey, unknown>();
      Object.defineProperty(api, namespace, {
        value: new Proxy(vscodeApi[namespace], {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (typeof value !== "function") return value;
            if (!methods.has(key))
              methods.set(key, (...args: unknown[]) =>
                extensionOwner.run(owner, () => Reflect.apply(value, target, args)),
              );
            return methods.get(key);
          },
        }),
      });
    }
    extensionApis.set(owner, api);
  }
  return api;
}
(globalThis as typeof globalThis & { __HARNESS_VSCODE_API__: unknown }).__HARNESS_VSCODE_API__ =
  vscodeApi;
(
  globalThis as typeof globalThis & { __HARNESS_VSCODE_API_FOR_EXTENSION__: typeof apiForExtension }
).__HARNESS_VSCODE_API_FOR_EXTENSION__ = apiForExtension;
ensureVscodeHooks();

const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") {
    return apiForExtension(
      extensionForSource((parent as { filename?: string } | undefined)?.filename) ??
        extensionOwner.getStore(),
    );
  }
  return originalLoad.call(this, request, parent, isMain);
};

function syncExtensions(): void {
  const notebooks: unknown[] = [];
  const linkRules: unknown[] = [];
  const taskTypes: string[] = [];
  const problemPatterns: unknown[] = [];
  const problemMatchers: unknown[] = [];
  const languageModelTools: unknown[] = [];
  const languageModelVendors: string[] = [];
  for (const manifest of manifests.values()) {
    const types = (manifest.packageJSON?.contributes as { notebooks?: unknown[] } | undefined)
      ?.notebooks;
    if (Array.isArray(types)) notebooks.push(...types);
    const links = (
      manifest.packageJSON?.contributes as { linkPresentationProviders?: unknown[] } | undefined
    )?.linkPresentationProviders;
    if (Array.isArray(links)) linkRules.push(...links);
    const tasks = (
      manifest.packageJSON?.contributes as { taskDefinitions?: { type: string }[] } | undefined
    )?.taskDefinitions;
    if (Array.isArray(tasks)) taskTypes.push(...tasks.map((task) => task.type));
    const problems = manifest.packageJSON?.contributes as
      | { problemPatterns?: unknown[]; problemMatchers?: unknown[] }
      | undefined;
    if (Array.isArray(problems?.problemPatterns)) problemPatterns.push(...problems.problemPatterns);
    if (Array.isArray(problems?.problemMatchers)) problemMatchers.push(...problems.problemMatchers);
    const tools = (
      manifest.packageJSON?.contributes as { languageModelTools?: unknown[] } | undefined
    )?.languageModelTools;
    if (Array.isArray(tools)) languageModelTools.push(...tools);
    const models = (
      manifest.packageJSON?.contributes as
        | { languageModelChatProviders?: { vendor: string }[] }
        | undefined
    )?.languageModelChatProviders;
    if (Array.isArray(models)) languageModelVendors.push(...models.map(({ vendor }) => vendor));
  }
  const defaults = readConfigurationDefaults(
    [...manifests.values()].map((manifest) => manifest.packageJSON?.contributes),
  );
  commandHandlers.get("__config.syncDefaults")?.(defaults);
  commandHandlers.get("__notebooks.syncTypes")?.(notebooks);
  commandHandlers.get("__links.syncRules")?.(linkRules);
  commandHandlers.get("__tasks.syncTypes")?.(taskTypes);
  commandHandlers.get("__tasks.syncProblemMatchers")?.({
    patterns: problemPatterns,
    matchers: problemMatchers,
  });
  commandHandlers.get("__lm.syncTools")?.(languageModelTools);
  commandHandlers.get("__lm.syncProviders")?.(languageModelVendors);
  commandHandlers.get("__ext.sync")?.(
    [...manifests.values()].map((manifest) => ({
      id: manifest.id,
      extensionPath: manifest.extensionPath,
      packageJSON: manifest.packageJSON ?? manifest,
      isActive: activatedExtensions.has(manifest.id.toLowerCase()),
      exports: activatedExtensions.get(manifest.id.toLowerCase())?.exports,
    })),
  );
}

async function deactivateExtension(key: string): Promise<void> {
  const extension = activatedExtensions.get(key);
  if (!extension) return;
  activatedExtensions.delete(key);
  try {
    await extension.deactivate?.();
  } catch (error) {
    console.error(error);
  }
  for (const subscription of extension.subscriptions) {
    try {
      await subscription.dispose();
    } catch (error) {
      console.error(error);
    }
  }
}

async function replaceManifests(next: readonly ExtensionManifest[]): Promise<void> {
  const previous = [...manifests];
  manifests.clear();
  for (const manifest of next) manifests.set(manifest.id.toLowerCase(), manifest);
  for (const [key, manifest] of previous.reverse()) {
    if (manifests.has(key)) continue;
    await activatingExtensions.get(key)?.catch(() => undefined);
    await deactivateExtension(key);
    localizationBundles.delete(manifest.extensionPath);
    environmentCollections.delete(key);
  }
  syncExtensions();
}

async function activateExtension(
  extensionId: string,
  parents: readonly string[] = activationChain.getStore() ?? [],
): Promise<unknown> {
  const key = extensionId.toLowerCase();
  const manifest = manifests.get(key);
  if (!manifest) throw new Error(`Extension '${extensionId}' is not installed`);
  if (activatedExtensions.has(key)) return activatedExtensions.get(key)?.exports;
  if (parents.includes(key))
    throw new Error(`Circular extension dependency: ${[...parents, key].join(" -> ")}`);
  const existing = activatingExtensions.get(key);
  if (existing) return existing;
  const activation = activationChain.run([...parents, key], () =>
    Promise.resolve().then(async () => {
      for (const dependency of manifest.extensionDependencies ?? [])
        await activateExtension(dependency, [...parents, key]);
      const subscriptions: { dispose(): unknown }[] = [];
      if (!manifest.main) {
        activatedExtensions.set(key, { subscriptions });
        syncExtensions();
        return undefined;
      }
      const bundle = await loadLocalizationBundle(
        manifest.extensionPath,
        manifest.packageJSON?.l10n,
        vscodeApi.env.language,
      );
      if (bundle) localizationBundles.set(manifest.extensionPath, bundle);
      const loaded = await extensionOwner.run(
        manifest.extensionPath,
        () => import(pathToFileURL(require.resolve(manifest.main!)).href),
      );
      const mod = (loaded.default ?? loaded) as {
        activate?: (context: unknown) => unknown;
        deactivate?: () => unknown;
      };
      const [globalState, workspaceState] = await Promise.all([
        createMemento(bridge, key, "global"),
        createMemento(bridge, key, "workspace"),
      ]);
      const workspaceId = createHash("sha256")
        .update(JSON.stringify(workspaceRoots))
        .digest("hex")
        .slice(0, 32);
      const globalStoragePath = path.join(storageRoot, "globalStorage", key);
      const storagePath = workspaceRoots.length
        ? path.join(storageRoot, "workspaceStorage", workspaceId, key)
        : undefined;
      if (storagePath) await mkdir(path.dirname(storagePath), { recursive: true });
      const logPath = path.join(storageRoot, "logs", vscodeApi.env.sessionId, key);
      const environmentFile = path.join(globalStoragePath, "environment.json");
      const environment =
        environmentCollections.get(key) ??
        createEnvironmentCollection(
          environmentFile,
          (await callMain("environment.load", environmentFile)) as string | undefined,
          (edit, legacy) => saveEnvironment(environmentFile, edit, legacy),
        );
      environmentCollections.set(key, environment);
      const context = {
        subscriptions,
        extensionPath: manifest.extensionPath,
        extensionUri: Uri.file(manifest.extensionPath),
        extensionMode: ExtensionMode.Production,
        globalStorageUri: Uri.file(globalStoragePath),
        globalStoragePath,
        storageUri: storagePath ? Uri.file(storagePath) : undefined,
        storagePath,
        logUri: Uri.file(logPath),
        logPath,
        environmentVariableCollection: environment.collection,
        extension: vscodeApi.extensions.getExtension(key),
        asAbsolutePath: (relativePath: string) =>
          path.resolve(manifest.extensionPath, relativePath),
        globalState,
        workspaceState,
        secrets: {
          onDidChange: (
            listener: (event: { key: string }) => unknown,
            thisArgs?: unknown,
            disposables?: { dispose(): unknown }[],
          ) => {
            let emitter = secretChanges.get(key);
            if (!emitter) {
              emitter = new EventEmitter<{ key: string }>();
              secretChanges.set(key, emitter);
              subscriptions.push({
                dispose() {
                  emitter?.dispose();
                  secretChanges.delete(key);
                },
              });
              void callMain("secrets.subscribe", key).catch((error: unknown) =>
                console.error(error),
              );
            }
            return emitter.event(listener, thisArgs, disposables);
          },
          get: (secret: string) => callMain("secrets.get", key, secret),
          store: (secret: string, value: string) => callMain("secrets.store", key, secret, value),
          delete: (secret: string) => callMain("secrets.delete", key, secret),
        },
      };
      try {
        const exports = typeof mod.activate === "function" ? await mod.activate(context) : mod;
        activatedExtensions.set(key, { exports, subscriptions, deactivate: mod.deactivate });
        syncExtensions();
        return exports;
      } catch (error) {
        for (const subscription of subscriptions) {
          try {
            subscription.dispose();
          } catch {}
        }
        throw error;
      }
    }),
  );
  activatingExtensions.set(key, activation);
  try {
    return await activation;
  } catch (error) {
    localizationBundles.delete(manifest.extensionPath);
    throw error;
  } finally {
    activatingExtensions.delete(key);
  }
}

async function activateByEvent(event: string, skipActivating = false): Promise<void> {
  const languageEvent = event.startsWith("onLanguage:");
  for (const manifest of manifests.values()) {
    if (
      skipActivating &&
      activatingExtensions.has(manifest.id.toLowerCase()) &&
      activationChain.getStore()?.includes(manifest.id.toLowerCase())
    )
      continue;
    const implicitCommand =
      event.startsWith("onCommand:") &&
      manifest.contributes?.commands?.some(({ command }) => event === `onCommand:${command}`);
    const contributions = manifest.packageJSON?.contributes as
      | {
          languages?: { id: string }[];
          notebooks?: { type: string }[];
          languageModelTools?: { name: string }[];
          authentication?: { id: string }[];
          languageModelChatProviders?: { vendor: string }[];
        }
      | undefined;
    const implicitContribution =
      contributions?.languages?.some(({ id }) => event === `onLanguage:${id}`) ||
      contributions?.notebooks?.some(({ type }) => event === `onNotebook:${type}`) ||
      contributions?.languageModelTools?.some(
        ({ name }) => event === `onLanguageModelTool:${name}`,
      ) ||
      contributions?.authentication?.some(({ id }) => event === `onAuthenticationRequest:${id}`) ||
      contributions?.languageModelChatProviders?.some(
        ({ vendor }) => event === `onLanguageModelChatProvider:${vendor}`,
      );
    if (
      manifest.activationEvents.includes(event) ||
      (languageEvent && manifest.activationEvents.includes("onLanguage")) ||
      manifest.activationEvents.includes("*") ||
      implicitCommand ||
      implicitContribution
    )
      await activateExtension(manifest.id);
  }
}

async function handleRequest(method: string, args: unknown[]): Promise<unknown> {
  if (method === "init") {
    const [roots, initialState = {}, extensions = []] = args as [
      string[],
      Record<string, unknown>?,
      ExtensionManifest[]?,
    ];
    workspaceRoots = roots;
    if (typeof initialState.storageRoot === "string")
      storageRoot = path.resolve(initialState.storageRoot);
    for (const extension of extensions) manifests.set(extension.id.toLowerCase(), extension);
    syncExtensions();
    commandHandlers.get("__webview.configure")?.(initialState.webviewResourceBase);
    if (initialState.configuration)
      commandHandlers.get("__config.sync")?.(initialState.configuration);
    if (initialState.documents) commandHandlers.get("__ws.syncDocuments")?.(initialState.documents);
    if (initialState.editors) commandHandlers.get("__win.syncEditors")?.(initialState.editors);
    if (initialState.editorDiagnostics)
      commandHandlers.get("__languages.syncEditorDiagnostics")?.(initialState.editorDiagnostics);
    if (initialState.environment) commandHandlers.get("__env.sync")?.(initialState.environment);
    if (initialState.windowState)
      commandHandlers.get("__win.syncState")?.(initialState.windowState);
    if (initialState.colorTheme)
      commandHandlers.get("__win.syncColorTheme")?.(initialState.colorTheme);
    if (initialState.tabGroups)
      commandHandlers.get("__win.syncTabGroups")?.(initialState.tabGroups);
    if (initialState.workspaceTrust)
      commandHandlers.get("__ws.syncTrust")?.(initialState.workspaceTrust);
    activateWorkspaceContainsExtensions();
    return true;
  }
  if (method === "syncExtensions") {
    const update = extensionSync.then(() => replaceManifests(args[0] as ExtensionManifest[]));
    extensionSync = update.catch(() => undefined);
    await update;
    activateWorkspaceContainsExtensions();
    return true;
  }
  if (method === "activate") {
    const [extensionId] = args as [string];
    await activateExtension(extensionId);
    return true;
  }
  if (method === "activateByEvent") {
    await activateByEvent(String(args[0]));
    return true;
  }
  if (method === "shutdown") {
    await extensionSync;
    workspaceContainsScan?.abort();
    for (const key of [...activatedExtensions.keys()].reverse()) await deactivateExtension(key);
    await commandHandlers.get("__chat.dispose")?.();
    await commandHandlers.get("__chatStatus.dispose")?.();
    await commandHandlers.get("__comments.dispose")?.();
    activatedExtensions.clear();
    await environmentWrites;
    await callMain("auth.unregisterSession");
    return true;
  }
  if (method === "executeCommand") {
    const [command, ...rest] = args as [string, ...unknown[]];
    if (!command.startsWith("__") && !commandHandlers.has(command))
      await activateByEvent(`onCommand:${command}`);
    requestContext.getStore()?.signal.throwIfAborted();
    const handler = commandHandlers.get(command);
    if (!handler) throw new Error(`Command not found in ExtHost: ${command}`);
    return await handler(...rest);
  }
  throw new Error(`Unknown ExtHost method: ${method}`);
}

process.on("message", async (msg: IpcMessage) => {
  if (msg.type === "response") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) entry.reject(decodeExtHostError({ ...msg, error: msg.error }));
    else entry.resolve(msg.result);
    return;
  }

  if (msg.type === "cancel") {
    const request = requests.get(msg.id);
    requests.delete(msg.id);
    request?.abort();
    return;
  }

  if (msg.type === "release") {
    commandHandlers.get(msg.command)?.(msg.listId);
    return;
  }

  if (msg.type === "request") {
    const request = new AbortController();
    const context: { signal: AbortSignal; release?: RpcResponse["release"] } = {
      signal: request.signal,
    };
    const releaseResponse = () => {
      const release = context.release;
      if (release) commandHandlers.get(release.command)?.(release.listId);
    };
    requests.set(msg.id, request);
    try {
      const result = await requestContext.run(context, () => handleRequest(msg.method, msg.args));
      if (!request.signal.aborted && process.connected) {
        process.send?.(
          {
            type: "response",
            id: msg.id,
            result,
            release: context.release,
          } satisfies RpcResponse,
          (error) => {
            if (error) releaseResponse();
          },
        );
      } else {
        releaseResponse();
      }
    } catch (error) {
      releaseResponse();
      if (request.signal.aborted || !process.connected) return;
      process.send?.({
        type: "response",
        id: msg.id,
        ...encodeExtHostError(error),
      } satisfies RpcResponse);
    } finally {
      requests.delete(msg.id);
    }
  }
});

process.on("disconnect", () => {
  workspaceContainsScan?.abort();
  for (const request of requests.values()) request.abort();
  requests.clear();
});
