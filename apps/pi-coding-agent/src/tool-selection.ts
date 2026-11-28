import { matchesGlob } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SystemMessage, type Message } from "@harness/llm";
import { AddToolMessage, RemoveToolMessage } from "@harness/tool-call";

const defaultTools = ["read", "bash", "edit", "write"];
export const builtinTools = [...defaultTools, "grep", "find", "ls"];

export interface PiToolOptions {
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly noTools?: boolean;
  readonly noBuiltinTools?: boolean;
}

const isModifier = (entry: string) => entry.startsWith("+") || entry.startsWith("-");
const toolMatches = (name: string, pattern: string) =>
  pattern.includes("*") ? matchesGlob(name, pattern) : name === pattern;

export interface ToolHistory {
  readonly active: readonly string[];
  readonly mentioned: ReadonlySet<string>;
}

export function toolSystemMessages(branch: readonly SessionEntry[]) {
  return branch.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
  );
}

export function readPiToolHistory(branch: readonly SessionEntry[]): ToolHistory | undefined {
  const mentioned = new Set<string>();
  const system = toolSystemMessages(branch);
  for (const message of system) {
    for (const { name } of message.toolsRemoved ?? []) mentioned.add(name);
    for (const { name } of message.toolsAdded ?? []) mentioned.add(name);
  }
  return mentioned.size > 0
    ? { active: getCurrentTools(system).map(({ name }) => name), mentioned }
    : undefined;
}

export function readToolHistory(
  messages: readonly Message[],
  branch: readonly SessionEntry[],
): ToolHistory | undefined {
  const projected = readPiToolHistory(branch);
  if (projected) return projected;
  const active = new Set<string>();
  const mentioned = new Set<string>();
  let hasSystem = false;
  for (const message of messages) {
    if (message instanceof AddToolMessage) {
      mentioned.add(message.tool.name);
      active.add(message.tool.name);
    } else if (message instanceof RemoveToolMessage) {
      mentioned.add(message.toolName);
      active.delete(message.toolName);
    } else if (message instanceof SystemMessage) {
      hasSystem = true;
    }
  }
  return hasSystem || mentioned.size > 0 || toolSystemMessages(branch).length > 0
    ? { active: [...active], mentioned }
    : undefined;
}

export function createToolSelection(
  defaults: readonly string[] | undefined,
  options: PiToolOptions = {},
) {
  const base = options.noTools || options.noBuiltinTools ? [] : [...(defaults ?? defaultTools)];
  const entries = options.tools;
  const modifiers = entries?.filter(isModifier) ?? [];
  if (
    modifiers.length > 0 &&
    (modifiers.length !== entries?.length ||
      modifiers.some((entry) => entry.length === 1 || entry.includes("*")))
  ) {
    throw new Error(
      "--tools expects either names and patterns or +name/-name modifiers with exact tool names",
    );
  }

  const applyModifiers = (names: readonly string[]) => {
    const modified = new Set(names);
    for (const entry of modifiers) {
      const name = entry.slice(1);
      if (entry.startsWith("+")) modified.add(name);
      else modified.delete(name);
    }
    return [...modified];
  };
  const added = new Set(applyModifiers([]));
  const removed = new Set(
    modifiers.map((entry) => entry.slice(1)).filter((name) => !added.has(name)),
  );

  const requested = modifiers.length > 0 ? applyModifiers(base) : (entries ?? base);
  const allowlist =
    options.noTools || (entries !== undefined && modifiers.length === 0) ? requested : undefined;
  const keepUnmatchedMcp =
    !options.noTools && !allowlist?.some((pattern) => pattern.startsWith("mcp__"));
  const isAllowed = (name: string, includeUnmatchedMcp = false) =>
    !options.excludeTools?.some((pattern) => toolMatches(name, pattern)) &&
    (allowlist === undefined ||
      allowlist.some((pattern) => toolMatches(name, pattern)) ||
      (includeUnmatchedMcp && keepUnmatchedMcp && name.startsWith("mcp__")));

  return {
    isAllowed,
    applyModifiers,
    isRemovedByModifier: (name: string) => removed.has(name),
    restoreOnStartup:
      !options.noTools &&
      !options.noBuiltinTools &&
      (entries === undefined || modifiers.length > 0),
    active(
      available: readonly string[],
      auto: readonly string[] = [],
      override?: readonly string[],
    ) {
      const names = override ?? [
        ...requested.flatMap((pattern) => available.filter((name) => toolMatches(name, pattern))),
        ...auto.filter((name) => !removed.has(name)),
      ];
      return [...new Set(names)].filter((name) => available.includes(name) && isAllowed(name));
    },
  };
}
