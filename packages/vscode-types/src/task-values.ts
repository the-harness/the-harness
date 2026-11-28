import type { Uri } from "./uri.ts";

export type TaskDefinition = { type: string; [key: string]: unknown };
export type ShellQuotedString = { value: string; quoting: number };
export type ShellExecutionOptions = {
  cwd?: string;
  env?: Record<string, string | null>;
  executable?: string;
  shellArgs?: string[];
};
export class ShellExecution {
  commandLine?: string;
  command?: string | ShellQuotedString;
  args: (string | ShellQuotedString)[];
  options: ShellExecutionOptions;
  constructor(
    command: string | ShellQuotedString,
    argsOrOptions?: (string | ShellQuotedString)[] | ShellExecutionOptions,
    options?: ShellExecutionOptions,
  ) {
    if (Array.isArray(argsOrOptions)) {
      this.command = command;
      this.args = argsOrOptions;
      this.options = options ?? {};
    } else {
      if (typeof command !== "string") throw new TypeError("Shell command line must be a string");
      this.commandLine = command;
      this.args = [];
      this.options = argsOrOptions ?? {};
    }
  }
}
export class ProcessExecution {
  process: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string | null> };
  constructor(
    process: string,
    argsOrOptions?: string[] | ProcessExecution["options"],
    options?: ProcessExecution["options"],
  ) {
    this.process = process;
    this.args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    this.options = Array.isArray(argsOrOptions) ? (options ?? {}) : (argsOrOptions ?? {});
  }
}
export class TaskGroup {
  static readonly Build = new TaskGroup("build", "Build");
  static readonly Test = new TaskGroup("test", "Test");
  static readonly Clean = new TaskGroup("clean", "Clean");
  static readonly Rebuild = new TaskGroup("rebuild", "Rebuild");
  readonly id: string;
  readonly label: string;
  isDefault?: boolean;
  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }
}
export class Task {
  definition: TaskDefinition;
  scope: number | { uri: Uri; name: string; index: number } | undefined;
  name: string;
  source: string;
  execution?: ShellExecution | ProcessExecution;
  problemMatchers: string[];
  group?: TaskGroup;
  isBackground = false;
  presentationOptions: Record<string, unknown> = {};
  runOptions: Record<string, unknown> = {};
  detail?: string;
  constructor(
    definition: TaskDefinition,
    scope: Task["scope"],
    name: string,
    source: string,
    execution?: ShellExecution | ProcessExecution,
    problemMatchers?: string | string[],
  );
  constructor(
    definition: TaskDefinition,
    name: string,
    source: string,
    execution?: ShellExecution | ProcessExecution,
    problemMatchers?: string | string[],
  );
  constructor(
    definition: TaskDefinition,
    scopeOrName: Task["scope"] | string,
    nameOrSource: string,
    sourceOrExecution?: string | ShellExecution | ProcessExecution,
    executionOrMatchers?: ShellExecution | ProcessExecution | string | string[],
    problemMatchers?: string | string[],
  ) {
    this.definition = definition;
    if (typeof scopeOrName === "string") {
      this.scope = 2;
      this.name = scopeOrName;
      this.source = nameOrSource;
      this.execution = sourceOrExecution as ShellExecution | ProcessExecution | undefined;
      problemMatchers = executionOrMatchers as string | string[] | undefined;
    } else {
      this.scope = scopeOrName;
      this.name = nameOrSource;
      this.source = sourceOrExecution as string;
      this.execution = executionOrMatchers as ShellExecution | ProcessExecution | undefined;
    }
    this.problemMatchers =
      typeof problemMatchers === "string" ? [problemMatchers] : (problemMatchers ?? []);
  }
}

export const TerminalCompletionItemKind = {
  File: 0,
  Folder: 1,
  Method: 2,
  Alias: 3,
  Argument: 4,
  Option: 5,
  OptionValue: 6,
  Flag: 7,
  SymbolicLinkFile: 8,
  SymbolicLinkFolder: 9,
  ScmCommit: 10,
  ScmBranch: 11,
  ScmTag: 12,
  ScmStash: 13,
  ScmRemote: 14,
  PullRequest: 15,
  PullRequestDone: 16,
} as const;
export class TerminalCompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  replacementRange: readonly [number, number];
  kind?: number;
  detail?: string;
  documentation?: unknown;
  constructor(
    label: TerminalCompletionItem["label"],
    replacementRange: readonly [number, number],
    kind?: number,
  ) {
    this.label = label;
    this.replacementRange = replacementRange;
    this.kind = kind;
  }
}
export class TerminalCompletionList<T = TerminalCompletionItem> {
  items: T[];
  resourceOptions?: {
    showFiles?: boolean;
    showDirectories?: boolean;
    globPattern?: string;
    cwd: Uri;
  };
  constructor(items: T[], resourceOptions?: TerminalCompletionList<T>["resourceOptions"]) {
    this.items = items;
    this.resourceOptions = resourceOptions;
  }
}

export class TerminalProfile {
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
}
