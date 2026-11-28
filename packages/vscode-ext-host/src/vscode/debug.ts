import { basename } from "node:path";
import type { ExtHostBridge } from "./bridge.ts";
import {
  Breakpoint,
  CancellationTokenSource,
  DebugAdapterServer,
  Disposable,
  EventEmitter,
  FunctionBreakpoint,
  SourceBreakpoint,
  Uri,
} from "./types.ts";
import { connectDebugAdapter, type DebugDescriptor, type DebugMessage } from "./debug-transport.ts";

export interface DebugConfiguration {
  // 扩展可按调试器类型补充配置字段。
  type: string;
  name: string;
  request: string;
  [key: string]: unknown;
}
type Folder = { uri: Uri; name: string; index: number };
type Session = {
  id: string;
  type: string;
  name: string;
  configuration: DebugConfiguration;
  workspaceFolder?: Folder;
  parentSession?: Session;
  customRequest(command: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
};
type ConfigurationProvider = {
  provideDebugConfigurations?(
    folder: Folder | undefined,
    token: CancellationTokenSource["token"],
  ): DebugConfiguration[] | PromiseLike<DebugConfiguration[]>;
  resolveDebugConfiguration?(
    folder: Folder | undefined,
    config: DebugConfiguration,
    token: CancellationTokenSource["token"],
  ): DebugConfiguration | undefined | null | PromiseLike<DebugConfiguration | undefined | null>;
  resolveDebugConfigurationWithSubstitutedVariables?(
    folder: Folder | undefined,
    config: DebugConfiguration,
    token: CancellationTokenSource["token"],
  ): DebugConfiguration | undefined | null | PromiseLike<DebugConfiguration | undefined | null>;
};
type Tracker = {
  onWillStartSession?(): void;
  onWillStopSession?(): void;
  onWillReceiveMessage?(message: DebugMessage): void;
  onDidSendMessage?(message: DebugMessage): void;
  onError?(error: Error): void;
  onExit?(code: number | undefined, signal?: string): void;
};
type TrackerFactory = {
  createDebugAdapterTracker(
    session: Session,
  ): Tracker | undefined | PromiseLike<Tracker | undefined>;
};
type DescriptorFactory = {
  createDebugAdapterDescriptor(
    session: Session,
    executable?: unknown,
  ): DebugDescriptor | undefined | PromiseLike<DebugDescriptor | undefined>;
};

export function createDebugNamespace(bridge: ExtHostBridge) {
  const started = new EventEmitter<Session>(),
    ended = new EventEmitter<Session>(),
    activeChanged = new EventEmitter<Session | undefined>();
  const custom = new EventEmitter<{ session: Session; event: string; body: unknown }>(),
    breakpointChanged = new EventEmitter<{
      added: Breakpoint[];
      removed: Breakpoint[];
      changed: Breakpoint[];
    }>();
  const descriptors = new Map<string, DescriptorFactory>();
  const trackers = new Map<string, Set<TrackerFactory>>();
  const configurations = new Map<string, Set<ConfigurationProvider>>();
  const sessions = new Map<
    string,
    {
      session: Session;
      transport: Awaited<ReturnType<typeof connectDebugAdapter>>;
      capabilities: Record<string, any>;
    }
  >();
  const breakpoints: Breakpoint[] = [];
  let active: Session | undefined;
  let consoleCreated = false;
  function append(value: string) {
    if (!consoleCreated) {
      consoleCreated = true;
      void bridge.callMain("output.create", "debug-console", "Debug Console");
    }
    void bridge.callMain("output.append", "debug-console", value);
  }
  function substitute(value: unknown, folder?: Folder): unknown {
    if (typeof value === "string")
      return value
        .replace(
          /\$\{workspaceFolder\}/g,
          folder?.uri.fsPath ?? bridge.getWorkspaceRoots()[0] ?? "",
        )
        .replace(/\$\{workspaceFolderBasename\}/g, folder?.name ?? "")
        .replace(/\$\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
    if (Array.isArray(value)) return value.map((item) => substitute(item, folder));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, substitute(item, folder)]),
      );
    return value;
  }
  async function updateBreakpoints(
    entry: {
      transport: Awaited<ReturnType<typeof connectDebugAdapter>>;
      capabilities: Record<string, any>;
    },
    extraPaths: string[] = [],
  ) {
    const files = new Map<string, SourceBreakpoint[]>();
    for (const path of extraPaths) files.set(path, []);
    for (const breakpoint of breakpoints)
      if (breakpoint instanceof SourceBreakpoint && breakpoint.enabled) {
        const path = breakpoint.location.uri.fsPath,
          values = files.get(path) ?? [];
        values.push(breakpoint);
        files.set(path, values);
      }
    for (const [path, values] of files)
      await entry.transport.request("setBreakpoints", {
        source: { path, name: basename(path) },
        breakpoints: values.map((value) => ({
          line: value.location.range.start.line + 1,
          column: value.location.range.start.character + 1,
          condition: value.condition,
          hitCondition: value.hitCondition,
          logMessage: value.logMessage,
        })),
      });
    if (entry.capabilities.supportsFunctionBreakpoints)
      await entry.transport.request("setFunctionBreakpoints", {
        breakpoints: breakpoints
          .filter((value) => value instanceof FunctionBreakpoint && value.enabled)
          .map((value) => ({
            name: (value as FunctionBreakpoint).functionName,
            condition: value.condition,
            hitCondition: value.hitCondition,
          })),
      });
  }
  async function startDebugging(
    folder: Folder | undefined,
    nameOrConfig: string | DebugConfiguration,
    parentOrOptions?: Session | { parentSession?: Session },
  ): Promise<boolean> {
    let config =
      typeof nameOrConfig === "string"
        ? (
            (await bridge.callMain(
              "workspace.getConfig",
              "launch.configurations",
              [],
            )) as DebugConfiguration[]
          ).find((item) => item.name === nameOrConfig)
        : { ...nameOrConfig };
    if (!config) return false;
    for (const event of ["onDebug", "onDebugResolve", `onDebugResolve:${config.type}`])
      await bridge.activateByEvent?.(event);
    const cancellation = new CancellationTokenSource();
    try {
      const providers = [
        ...(configurations.get("*") ?? []),
        ...(configurations.get(config.type) ?? []),
      ];
      for (const provider of providers) {
        if (provider.resolveDebugConfiguration)
          config =
            (await provider.resolveDebugConfiguration(folder, config, cancellation.token)) ??
            undefined;
        if (!config) return false;
      }
      config = substitute(config, folder) as DebugConfiguration;
      for (const provider of providers) {
        if (provider.resolveDebugConfigurationWithSubstitutedVariables)
          config =
            (await provider.resolveDebugConfigurationWithSubstitutedVariables(
              folder,
              config,
              cancellation.token,
            )) ?? undefined;
        if (!config) return false;
      }
    } finally {
      cancellation.dispose();
    }
    const parentSession =
      parentOrOptions && "id" in parentOrOptions ? parentOrOptions : parentOrOptions?.parentSession;
    const id = crypto.randomUUID();
    let transport: Awaited<ReturnType<typeof connectDebugAdapter>> | undefined;
    const session: Session = {
      id,
      type: config.type,
      name: config.name,
      configuration: config,
      workspaceFolder: folder,
      parentSession,
      customRequest(command, args) {
        if (!transport) return Promise.reject(new Error("Debug adapter is not connected"));
        return transport.request(command, args);
      },
    };
    const localTrackers = (
      await Promise.all(
        [...(trackers.get("*") ?? []), ...(trackers.get(config.type) ?? [])].map((factory) =>
          factory.createDebugAdapterTracker(session),
        ),
      )
    ).filter((value): value is Tracker => Boolean(value));
    const descriptor =
      typeof config.debugServer === "number"
        ? new DebugAdapterServer(config.debugServer)
        : await descriptors.get(config.type)?.createDebugAdapterDescriptor(session);
    if (!descriptor) throw new Error(`No debug adapter descriptor for ${config.type}`);
    const initialized = Promise.withResolvers<void>();
    let finished = false;
    let terminating = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      for (const tracker of localTrackers) {
        if (error) tracker.onError?.(error);
        tracker.onWillStopSession?.();
      }
      sessions.delete(id);
      if (active === session) {
        active = [...sessions.values()].at(-1)?.session;
        activeChanged.fire(active);
      }
      ended.fire(session);
      transport?.dispose();
    };
    const reverse = async (message: DebugMessage) => {
      try {
        let body: Record<string, unknown>;
        if (message.command === "startDebugging") {
          const success = await startDebugging(
            folder,
            message.arguments?.configuration as DebugConfiguration,
            { parentSession: session },
          );
          if (!success) throw new Error("Child debug session did not start");
          body = {};
        } else if (message.command === "runInTerminal")
          body = (await bridge.callMain("debug.runInTerminal", message.arguments)) as Record<
            string,
            unknown
          >;
        else throw new Error(`Unsupported debug adapter request: ${message.command}`);
        transport!.respond(message, body);
      } catch (error) {
        transport?.respond(
          message,
          undefined,
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    try {
      for (const tracker of localTrackers) tracker.onWillStartSession?.();
      transport = await connectDebugAdapter(
        descriptor,
        (message) => {
          for (const tracker of localTrackers) tracker.onDidSendMessage?.(message);
          if (message.type === "request") void reverse(message);
          if (message.type !== "event") return;
          if (message.event === "initialized") initialized.resolve();
          else if (message.event === "output") {
            if (message.body?.category !== "telemetry" && typeof message.body?.output === "string")
              append(message.body.output);
          } else if (message.event === "exited")
            for (const tracker of localTrackers) tracker.onExit?.(message.body?.exitCode);
          else if (message.event === "terminated" && !terminating) {
            terminating = true;
            void transport!.request("disconnect", { restart: Boolean(message.body?.restart) }).then(
              () => finish(),
              (error) => finish(error instanceof Error ? error : new Error(String(error))),
            );
          } else custom.fire({ session, event: message.event!, body: message.body });
        },
        (message) => {
          for (const tracker of localTrackers) tracker.onWillReceiveMessage?.(message);
        },
        finish,
      );
      const capabilities = await transport.request("initialize", {
        clientID: "harness",
        clientName: "Harness",
        adapterID: config.type,
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsRunInTerminalRequest: true,
        supportsStartDebuggingRequest: true,
      });
      const entry = { session, transport, capabilities };
      sessions.set(id, entry);
      active = session;
      activeChanged.fire(active);
      started.fire(session);
      const launch = transport.request(config.request, config);
      void launch.catch(() => {});
      await Promise.race([initialized.promise, launch.then(() => undefined)]);
      await updateBreakpoints(entry);
      if (capabilities.supportsConfigurationDoneRequest)
        await transport.request("configurationDone");
      await launch;
      return true;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  bridge.commandHandlers.set("__debug.startType", async (rawType) => {
    const type = String(rawType),
      folderPath = bridge.getWorkspaceRoots()[0];
    const folder = folderPath
      ? { uri: Uri.file(folderPath), name: basename(folderPath), index: 0 }
      : undefined;
    const token = new CancellationTokenSource();
    try {
      const configs = (
        await Promise.all(
          [...(configurations.get(type) ?? [])].map(
            (provider) => provider.provideDebugConfigurations?.(folder, token.token) ?? [],
          ),
        )
      ).flat();
      if (!configs.length) throw new Error(`No debug configurations for ${type}`);
      return await startDebugging(folder, configs[0]!);
    } finally {
      token.dispose();
    }
  });
  return {
    get activeDebugSession() {
      return active;
    },
    activeDebugConsole: {
      append,
      appendLine(value: string) {
        append(value + "\n");
      },
    },
    onDidStartDebugSession: started.event,
    onDidTerminateDebugSession: ended.event,
    onDidChangeActiveDebugSession: activeChanged.event,
    onDidReceiveDebugSessionCustomEvent: custom.event,
    onDidChangeBreakpoints: breakpointChanged.event,
    get breakpoints() {
      return [...breakpoints];
    },
    addBreakpoints(values: Breakpoint[]) {
      const added = values.filter(
        (value) => !breakpoints.some((existing) => existing.id === value.id),
      );
      breakpoints.push(...added);
      if (added.length) {
        breakpointChanged.fire({ added, removed: [], changed: [] });
        for (const entry of sessions.values()) void updateBreakpoints(entry);
      }
    },
    removeBreakpoints(values: Breakpoint[]) {
      const removed = breakpoints.filter((value) => values.some((item) => item.id === value.id));
      for (const value of removed) breakpoints.splice(breakpoints.indexOf(value), 1);
      if (removed.length) {
        breakpointChanged.fire({ added: [], removed, changed: [] });
        const paths = removed
          .filter((value) => value instanceof SourceBreakpoint)
          .map((value) => (value as SourceBreakpoint).location.uri.fsPath);
        for (const entry of sessions.values()) void updateBreakpoints(entry, paths);
      }
    },
    asDebugSourceUri(source: { path?: string; sourceReference?: number }, session?: Session) {
      return source.sourceReference
        ? Uri.from({
            scheme: "debug",
            path: source.path ?? "source",
            query: `session=${session?.id ?? active?.id ?? ""}&ref=${source.sourceReference}`,
          })
        : Uri.file(source.path ?? "");
    },
    registerDebugAdapterDescriptorFactory(type: string, factory: DescriptorFactory) {
      if (descriptors.has(type))
        throw new Error(`Debug adapter descriptor factory already registered: ${type}`);
      descriptors.set(type, factory);
      return new Disposable(() => {
        if (descriptors.get(type) === factory) descriptors.delete(type);
      });
    },
    registerDebugAdapterTrackerFactory(type: string, factory: TrackerFactory) {
      const entries = trackers.get(type) ?? new Set();
      entries.add(factory);
      trackers.set(type, entries);
      return new Disposable(() => {
        entries.delete(factory);
        if (!entries.size) trackers.delete(type);
      });
    },
    registerDebugConfigurationProvider(
      type: string,
      provider: ConfigurationProvider,
      _triggerKind?: number,
    ) {
      const entries = configurations.get(type) ?? new Set();
      entries.add(provider);
      configurations.set(type, entries);
      void bridge.callMain("debug.registerProvider", type);
      return new Disposable(() => {
        entries.delete(provider);
        if (!entries.size) {
          configurations.delete(type);
          void bridge.callMain("debug.unregisterProvider", type);
        }
      });
    },
    startDebugging,
    async stopDebugging(session = active): Promise<void> {
      if (!session) return;
      const entry = sessions.get(session.id);
      if (!entry) return;
      try {
        await entry.transport.request("disconnect", { terminateDebuggee: true });
      } finally {
        entry.transport.dispose();
      }
    },
  };
}
