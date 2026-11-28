import { readFileSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import {
  applyEnvironmentEdit,
  restoreEnvironment,
  type EnvironmentEdit,
} from "../environment-edits.ts";
import { Uri } from "./types.ts";

type Scope = { workspaceFolder?: { uri: Uri; index: number; name: string } };
type MutatorOptions = { applyAtProcessCreation?: boolean; applyAtShellIntegration?: boolean };
type Mutator = { value: string; type: 1 | 2 | 3; options: MutatorOptions };
type Collection = {
  persistent: boolean;
  description: string | { value: string } | undefined;
  replace(variable: string, value: string, options?: MutatorOptions): void;
  append(variable: string, value: string, options?: MutatorOptions): void;
  prepend(variable: string, value: string, options?: MutatorOptions): void;
  get(variable: string): Mutator | undefined;
  delete(variable: string): void;
  clear(): void;
  forEach(
    callback: (variable: string, mutator: Mutator, collection: Collection) => void,
    thisArg?: unknown,
  ): void;
  [Symbol.iterator](): IterableIterator<[string, Mutator]>;
  getScoped(scope?: Scope): Collection;
};

export function createEnvironmentCollection(
  legacyFile: string,
  stored: string | undefined,
  persist: (edit: EnvironmentEdit, legacy?: string) => void,
) {
  const descriptions = new Map<string, string>();
  const scopes = new Map<string, Collection>();
  let persistent = true;
  let legacy: string | undefined;
  try {
    if (stored === undefined) legacy = readFileSync(legacyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const values = restoreEnvironment(stored ?? legacy ?? "[]");
  const save = (edit: EnvironmentEdit) => {
    persist(edit, legacy);
    legacy = undefined;
  };
  const apply = (edit: EnvironmentEdit) => {
    applyEnvironmentEdit(values, edit);
    if (persistent) save(edit);
  };
  const scoped = (scope?: Scope): Collection => {
    const folder = scope?.workspaceFolder?.uri.toString();
    const existing = scopes.get(folder ?? "");
    if (existing) return existing;
    const entries = () =>
      [...values.values()]
        .filter((entry) => entry.folder === folder)
        .map(
          ({ variable, value, type, options }) =>
            [variable, { value, type, options }] as [string, Mutator],
        );
    const set = (variable: string, value: string, type: 1 | 2 | 3, options?: MutatorOptions) => {
      if (options?.applyAtProcessCreation === false && !options.applyAtShellIntegration)
        throw new Error("Environment mutators must apply at process creation or shell integration");
      const entry = {
        variable,
        value,
        type,
        folder,
        options: options
          ? {
              applyAtProcessCreation: options.applyAtProcessCreation ?? false,
              applyAtShellIntegration: options.applyAtShellIntegration ?? false,
            }
          : { applyAtProcessCreation: true },
      };
      apply({ op: "set", entry });
    };
    const collection: Collection = {
      get persistent() {
        return persistent;
      },
      set persistent(value: boolean) {
        if (persistent === value) return;
        persistent = value;
        if (value) {
          for (const entry of values.values()) save({ op: "set", entry });
        } else {
          save({ op: "clear" });
        }
      },
      get description() {
        return descriptions.get(folder ?? "");
      },
      set description(value: string | { value: string } | undefined) {
        if (value === undefined) descriptions.delete(folder ?? "");
        else
          descriptions.set(
            folder ?? "",
            typeof value === "string" ? value : value.value.split("\n\n")[0]!,
          );
      },
      replace: (variable: string, value: string, options?: MutatorOptions) =>
        set(variable, value, 1, options),
      append: (variable: string, value: string, options?: MutatorOptions) =>
        set(variable, value, 2, options),
      prepend: (variable: string, value: string, options?: MutatorOptions) =>
        set(variable, value, 3, options),
      get(variable: string) {
        return entries().find(([name]) => variable === name)?.[1];
      },
      delete(variable: string) {
        apply({ op: "delete", variable, folder });
      },
      clear() {
        if (!folder) descriptions.clear();
        else descriptions.delete(folder);
        apply({ op: "clear", folder });
      },
      forEach(callback, thisArg) {
        for (const [variable, mutator] of entries())
          callback.call(thisArg, variable, mutator, collection);
      },
      [Symbol.iterator]: () => entries()[Symbol.iterator](),
      getScoped: scoped,
    };
    scopes.set(folder ?? "", collection);
    return collection;
  };
  return {
    collection: scoped(),
    apply(env: Record<string, string | null>, cwd?: string) {
      for (const entry of values.values()) {
        if (!entry.options.applyAtProcessCreation) continue;
        if (entry.folder) {
          if (!cwd) continue;
          const rest = relative(Uri.parse(entry.folder).fsPath, cwd);
          if (
            rest === ".." ||
            rest.startsWith("../") ||
            rest.startsWith("..\\") ||
            isAbsolute(rest)
          )
            continue;
        }
        const existing = env[entry.variable] ?? "";
        env[entry.variable] =
          entry.type === 1
            ? entry.value
            : entry.type === 2
              ? existing + entry.value
              : entry.value + existing;
      }
    },
  };
}
