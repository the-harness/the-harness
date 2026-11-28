import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtHostBridge } from "./bridge.ts";
import { Disposable, EventEmitter, LogLevel, UIKind, type Event, type Uri } from "./types.ts";

export interface DataChannel<T = unknown> {
  readonly onDidReceiveData: Event<{ data: T }>;
}
type SystemIdleState = "active" | "idle" | "locked" | "unknown";
type ThermalState = "unknown" | "nominal" | "fair" | "serious" | "critical";

type TelemetryData = Record<string, unknown>;
interface TelemetrySender {
  // Implemented by extensions to deliver enabled telemetry to their own service.
  sendEventData(eventName: string, data?: TelemetryData): void;
  sendErrorData(error: Error, data?: TelemetryData): void;
  flush?(): void | PromiseLike<void>;
}

export function createEnvNamespace(bridge: ExtHostBridge) {
  const unavailablePowerEvent =
    <T>(): Event<T> =>
    () =>
      new Disposable(() => {});
  const webPower = {
    onDidSuspend: unavailablePowerEvent<void>(),
    onDidResume: unavailablePowerEvent<void>(),
    onDidChangeOnBatteryPower: unavailablePowerEvent<boolean>(),
    onDidChangeThermalState: unavailablePowerEvent<ThermalState>(),
    onDidChangeSpeedLimit: unavailablePowerEvent<number>(),
    onWillShutdown: unavailablePowerEvent<void>(),
    onDidLockScreen: unavailablePowerEvent<void>(),
    onDidUnlockScreen: unavailablePowerEvent<void>(),
    async getSystemIdleState(_idleThresholdSeconds: number): Promise<SystemIdleState> {
      return "unknown";
    },
    async getSystemIdleTime(): Promise<number> {
      return 0;
    },
    async getCurrentThermalState(): Promise<ThermalState> {
      return "unknown";
    },
    async isOnBatteryPower(): Promise<boolean> {
      return false;
    },
    async startPowerSaveBlocker(_type: "prevent-app-suspension" | "prevent-display-sleep") {
      return {
        id: -1,
        get isStarted() {
          return false;
        },
        dispose() {},
      };
    },
  };
  let state = {
    language: "en",
    appName: "Harness",
    appRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
    appHost: "web",
    uriScheme: "harness",
    uiKind: UIKind.Web,
    remoteName: undefined as string | undefined,
    machineId: createHash("sha256").update(`harness:${hostname()}`).digest("hex"),
    sessionId: randomUUID() as string,
    isTelemetryEnabled: false,
    telemetryLevel: "off",
    logLevel: LogLevel.Info,
    isMeteredConnection: false,
  };
  const telemetryChanged = new EventEmitter<boolean>();
  const logLevelChanged = new EventEmitter<number>();
  const meteredChanged = new EventEmitter<boolean>();
  const dataChannels = new Map<
    string,
    { channel: DataChannel; events: EventEmitter<{ data: unknown }> }
  >();
  bridge.commandHandlers.set("__env.onDidReceiveData", (channelId, data) => {
    dataChannels.get(channelId as string)?.events.fire({ data });
  });
  bridge.commandHandlers.set("__env.sync", (value) => {
    const previous = state;
    state = { ...state, ...(value as Partial<typeof state>) };
    if (
      previous.isTelemetryEnabled !== state.isTelemetryEnabled ||
      previous.telemetryLevel !== state.telemetryLevel
    )
      telemetryChanged.fire(state.isTelemetryEnabled);
    if (previous.logLevel !== state.logLevel) logLevelChanged.fire(state.logLevel);
    if (previous.isMeteredConnection !== state.isMeteredConnection)
      meteredChanged.fire(state.isMeteredConnection);
  });
  const enabled = () => state.isTelemetryEnabled && state.telemetryLevel !== "off";
  return {
    get appName() {
      return state.appName;
    },
    get appRoot() {
      return state.appRoot;
    },
    get appHost() {
      return state.appHost;
    },
    get uriScheme() {
      return state.uriScheme;
    },
    get language() {
      return state.language;
    },
    get uiKind() {
      return state.uiKind;
    },
    get remoteName() {
      return state.remoteName;
    },
    get machineId() {
      return state.machineId;
    },
    get sessionId() {
      return state.sessionId;
    },
    get shell() {
      return process.env.SHELL ?? "";
    },
    get isTelemetryEnabled() {
      return enabled();
    },
    get logLevel() {
      return state.logLevel;
    },
    get isMeteredConnection() {
      return state.isMeteredConnection;
    },
    get power() {
      if (state.uiKind !== UIKind.Web)
        throw new Error("Native power APIs are unavailable in this extension host");
      return webPower;
    },
    onDidChangeTelemetryEnabled: telemetryChanged.event,
    onDidChangeLogLevel: logLevelChanged.event,
    onDidChangeMeteredConnection: meteredChanged.event,
    getDataChannel<T>(channelId: string): DataChannel<T> {
      let entry = dataChannels.get(channelId);
      if (!entry) {
        const events = new EventEmitter<{ data: unknown }>();
        const channel = {
          onDidReceiveData: events.event,
          toString: () => `DataChannel(${channelId})`,
        };
        entry = { channel, events };
        dataChannels.set(channelId, entry);
      }
      return entry.channel as DataChannel<T>;
    },
    createTelemetryLogger(
      sender: TelemetrySender,
      options?: {
        additionalCommonProperties?: TelemetryData;
        ignoreBuiltInCommonProperties?: boolean;
        ignoreUnhandledErrors?: boolean;
      },
    ) {
      if (typeof sender.sendEventData !== "function" || typeof sender.sendErrorData !== "function")
        throw new TypeError("Invalid telemetry sender");
      let disposed = false;
      const changes = new EventEmitter<typeof logger>();
      const prepare = (data?: TelemetryData) => ({
        ...options?.additionalCommonProperties,
        ...data,
      });
      const logger = {
        get isUsageEnabled() {
          return !disposed && enabled() && state.telemetryLevel === "all";
        },
        get isErrorsEnabled() {
          return !disposed && enabled();
        },
        onDidChangeEnableStates: changes.event,
        logUsage(eventName: string, data?: TelemetryData) {
          if (logger.isUsageEnabled) sender.sendEventData(eventName, prepare(data));
        },
        logError(error: string | Error, data?: TelemetryData) {
          if (!logger.isErrorsEnabled) return;
          if (typeof error === "string") sender.sendEventData(error, prepare(data));
          else sender.sendErrorData(error, prepare(data));
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          subscription.dispose();
          changes.dispose();
          void sender.flush?.();
        },
      };
      const subscription = telemetryChanged.event(() => changes.fire(logger));
      return logger;
    },
    clipboard: {
      readText: () => bridge.callMain("env.clipboard.readText") as Promise<string>,
      writeText: (value: string) =>
        bridge.callMain("env.clipboard.writeText", value) as Promise<void>,
    },
    async openExternal(
      target: Uri,
      options?: { allowContributedOpeners?: boolean | string },
    ): Promise<boolean> {
      const result = await bridge.commandHandlers.get("__externalUri.open")?.(
        target,
        options?.allowContributedOpeners,
      );
      return typeof result === "boolean"
        ? result
        : ((await bridge.callMain("env.openExternal", target.toString())) as boolean);
    },
  };
}
