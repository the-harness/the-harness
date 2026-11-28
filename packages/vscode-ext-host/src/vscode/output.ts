import { format } from "node:util";
import type { ExtHostBridge } from "./bridge.ts";
import type { createEnvNamespace } from "./env.ts";
import { EventEmitter, LogLevel } from "./types.ts";

export function createOutputApi(
  bridge: ExtHostBridge,
  environment: ReturnType<typeof createEnvNamespace>,
) {
  return {
    createOutputChannel(rawName: string, options?: string | { log: true }) {
      const name = rawName.trim();
      if (!name) throw new Error("Output channel name must not be empty");
      if (typeof options === "string" && !options.trim())
        throw new Error("Output language must not be empty");
      const isLog = typeof options === "object" && options.log;
      const id = crypto.randomUUID();
      let disposed = false;
      const changed = new EventEmitter<number>();
      const subscription = environment.onDidChangeLogLevel((level) => changed.fire(level));
      void bridge.callMain("output.create", id, name);
      const validate = () => {
        if (disposed) throw new Error("Channel has been closed");
      };
      const write = (method: string, ...args: unknown[]) => {
        validate();
        void bridge.callMain(method, id, ...args);
      };
      const formatLog = (level: number, message: string | Error, args: unknown[]) => {
        validate();
        if (environment.logLevel === LogLevel.Off || level < environment.logLevel) return;
        const label = ["off", "trace", "debug", "info", "warning", "error"][level];
        const value = message instanceof Error ? (message.stack ?? message.message) : message;
        return `[${new Date().toISOString()}] [${label}] ${format(value, ...args)}`;
      };
      const log = (level: number, message: string | Error, args: unknown[]) => {
        const line = formatLog(level, message, args);
        if (line !== undefined) write("output.appendLine", line);
      };
      const channel = {
        name,
        append(value: string) {
          if (isLog) log(LogLevel.Info, value, []);
          else write("output.append", value);
        },
        appendLine(value: string) {
          if (isLog) log(LogLevel.Info, value, []);
          else write("output.appendLine", value);
        },
        replace(value: string) {
          const formatted = isLog ? formatLog(LogLevel.Info, value, []) : undefined;
          write(
            "output.replace",
            isLog ? (formatted === undefined ? "" : `${formatted}\n`) : value,
          );
        },
        clear() {
          write("output.clear");
        },
        show(columnOrPreserveFocus?: number | boolean, preserveFocus?: boolean) {
          write(
            "output.show",
            typeof columnOrPreserveFocus === "boolean" ? columnOrPreserveFocus : !!preserveFocus,
          );
        },
        hide() {
          write("output.hide");
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          subscription.dispose();
          changed.dispose();
          void bridge.callMain("output.dispose", id);
        },
      };
      if (!isLog) return channel;
      return {
        ...channel,
        get logLevel() {
          return environment.logLevel;
        },
        onDidChangeLogLevel: changed.event,
        trace: (message: string, ...args: unknown[]) => log(LogLevel.Trace, message, args),
        debug: (message: string, ...args: unknown[]) => log(LogLevel.Debug, message, args),
        info: (message: string, ...args: unknown[]) => log(LogLevel.Info, message, args),
        warn: (message: string, ...args: unknown[]) => log(LogLevel.Warning, message, args),
        error: (message: string | Error, ...args: unknown[]) => log(LogLevel.Error, message, args),
      };
    },
  };
}
