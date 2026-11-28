import type { Location } from "./language-values.ts";

export const DebugConfigurationProviderTriggerKind = { Initial: 1, Dynamic: 2 } as const;
export class DebugAdapterExecutable {
  command: string;
  args: string[];
  options?: { cwd?: string; env?: Record<string, string | null> };
  constructor(command: string, args: string[] = [], options?: DebugAdapterExecutable["options"]) {
    this.command = command;
    this.args = args;
    this.options = options;
  }
}
export class DebugAdapterServer {
  port: number;
  host?: string;
  constructor(port: number, host?: string) {
    this.port = port;
    this.host = host;
  }
}
export class DebugAdapterNamedPipeServer {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}
export class DebugAdapterInlineImplementation {
  implementation: {
    handleMessage(message: unknown): void;
    onDidSendMessage(listener: (message: unknown) => void): { dispose(): void };
    dispose(): unknown;
  };
  constructor(implementation: DebugAdapterInlineImplementation["implementation"]) {
    this.implementation = implementation;
  }
}
export class Breakpoint {
  readonly id = crypto.randomUUID();
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  constructor(enabled = true, condition?: string, hitCondition?: string, logMessage?: string) {
    this.enabled = enabled;
    this.condition = condition;
    this.hitCondition = hitCondition;
    this.logMessage = logMessage;
  }
}
export class SourceBreakpoint extends Breakpoint {
  location: Location;
  constructor(
    location: Location,
    enabled = true,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled, condition, hitCondition, logMessage);
    this.location = location;
  }
}
export class FunctionBreakpoint extends Breakpoint {
  functionName: string;
  constructor(
    functionName: string,
    enabled = true,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled, condition, hitCondition, logMessage);
    this.functionName = functionName;
  }
}
