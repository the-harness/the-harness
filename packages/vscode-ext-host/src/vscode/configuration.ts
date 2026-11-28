import { isDeepStrictEqual } from "node:util";
import {
  overrides,
  readValue,
  resolveConfiguration,
  type ConfigurationSnapshot,
} from "@harness/ui-config/configuration";
import type { ExtHostBridge } from "./bridge.ts";
import { EventEmitter, type Uri } from "./types.ts";

type ConfigurationScope = Uri | { languageId?: string; uri?: Uri } | null;

type VersionedConfiguration = ConfigurationSnapshot & { readonly revision?: number };

const targets = ["defaults", "user", "workspace"] as const;

function languageFor(scope?: ConfigurationScope): string | undefined {
  const language =
    scope && typeof scope === "object" && "languageId" in scope ? scope.languageId : undefined;
  return typeof language === "string" && language ? language : undefined;
}

function overrideLanguages(...snapshots: ConfigurationSnapshot[]): string[] {
  const ids = new Set<string>();
  for (const snapshot of snapshots) {
    for (const target of targets) {
      for (const key of Object.keys(snapshot[target])) {
        if (!/^(?:\[[^[\]]+\])+$/.test(key)) continue;
        for (const [, language] of key.matchAll(/\[([^\]]+)\]/g)) ids.add(language!);
      }
    }
  }
  return [...ids];
}

export function createConfigurationApi(bridge: ExtHostBridge) {
  let state: ConfigurationSnapshot = { defaults: {}, user: {}, workspace: {} };
  let contributedDefaults: Record<string, unknown> = {};
  let suppliedDefaults: Record<string, unknown> = {};
  let initialized = false;
  let revision = -1;
  const changes = new EventEmitter<{
    affectsConfiguration(section: string, scope?: ConfigurationScope): boolean;
  }>();

  const sync = (next: ConfigurationSnapshot) => {
    const previous = state;
    state = next;
    if (initialized && !isDeepStrictEqual(previous, next)) {
      const languages = overrideLanguages(previous, next);
      changes.fire({
        affectsConfiguration: (section, scope) => {
          if (scope !== undefined) {
            const language = languageFor(scope);
            return !isDeepStrictEqual(
              resolveConfiguration(previous, section, language),
              resolveConfiguration(next, section, language),
            );
          }
          return targets.some((target) => {
            const before = previous[target];
            const after = next[target];
            return (
              !isDeepStrictEqual(readValue(before, section), readValue(after, section)) ||
              languages.some(
                (language) =>
                  !isDeepStrictEqual(
                    readValue(overrides(before, language), section),
                    readValue(overrides(after, language), section),
                  ),
              )
            );
          });
        },
      });
    }
    initialized = true;
  };

  const acceptSnapshot = (next: VersionedConfiguration) => {
    if (next.revision !== undefined) {
      if (next.revision <= revision) return;
      revision = next.revision;
    }
    suppliedDefaults = next.defaults;
    sync({
      defaults: { ...contributedDefaults, ...suppliedDefaults },
      user: next.user,
      workspace: next.workspace,
    });
  };

  bridge.commandHandlers.set("__config.syncDefaults", (raw) => {
    contributedDefaults = raw as Record<string, unknown>;
    sync({ ...state, defaults: { ...contributedDefaults, ...suppliedDefaults } });
  });
  bridge.commandHandlers.set("__config.sync", (raw) =>
    acceptSnapshot(raw as VersionedConfiguration),
  );

  return {
    onDidChangeConfiguration: changes.event,
    getConfiguration(section?: string, scope?: ConfigurationScope) {
      const key = (name: string) => (section ? `${section}.${name}` : name);
      const snapshot = state;
      const language = languageFor(scope);
      const properties = resolveConfiguration(snapshot, section ?? "", language);
      return Object.assign(
        {},
        properties && typeof properties === "object" ? structuredClone(properties) : {},
        {
          get<T = unknown>(name: string, defaultValue?: T): T | undefined {
            const found = resolveConfiguration(snapshot, key(name), language);
            return found === undefined ? defaultValue : (structuredClone(found) as T);
          },
          has(name: string): boolean {
            return resolveConfiguration(snapshot, key(name), language) !== undefined;
          },
          inspect<T = unknown>(name: string) {
            const fullKey = key(name);
            const languageIds = overrideLanguages(snapshot).filter((id) =>
              targets.some(
                (target) => readValue(overrides(snapshot[target], id), fullKey) !== undefined,
              ),
            );
            if (
              !languageIds.length &&
              resolveConfiguration(snapshot, fullKey, language) === undefined
            ) {
              return undefined;
            }
            const baseValue = (target: (typeof targets)[number]) =>
              structuredClone(readValue(snapshot[target], fullKey)) as T | undefined;
            const languageValue = (target: (typeof targets)[number]) =>
              language
                ? (structuredClone(readValue(overrides(snapshot[target], language), fullKey)) as
                    | T
                    | undefined)
                : undefined;
            return {
              key: fullKey,
              defaultValue: baseValue("defaults"),
              globalValue: baseValue("user"),
              workspaceValue: baseValue("workspace"),
              defaultLanguageValue: languageValue("defaults"),
              globalLanguageValue: languageValue("user"),
              workspaceLanguageValue: languageValue("workspace"),
              languageIds: languageIds.length ? languageIds : undefined,
            };
          },
          async update(
            name: string,
            value: unknown,
            target?: number | boolean | null,
            overrideInLanguage?: boolean,
          ): Promise<void> {
            if (target === 3)
              throw new Error("Workspace-folder configuration updates are not supported");
            if (
              target !== undefined &&
              target !== null &&
              typeof target !== "boolean" &&
              target !== 1 &&
              target !== 2
            ) {
              throw new Error("Invalid configuration target");
            }
            const layer = target === true || target === 1 ? "user" : "workspace";
            const next = (await bridge.callMain(
              "workspace.updateConfig",
              key(name),
              value,
              layer,
              value === undefined,
              ...(language ? [{ languageId: language, overrideInLanguage }] : []),
            )) as VersionedConfiguration | undefined;
            if (next) acceptSnapshot(next);
          },
        },
      );
    },
  };
}
