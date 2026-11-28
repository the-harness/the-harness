import type { VscodeConfigAdapter, VscodeConfigTarget } from "../vscode-config.ts";
import { overrides, readValue } from "@harness/ui-config/configuration";

export interface ConfigurationUpdateScope {
  readonly languageId: string;
  readonly overrideInLanguage?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutSetting(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  let changed = false;
  const entries: [string, unknown][] = [];
  for (const [name, value] of Object.entries(settings)) {
    if (name === key || name.startsWith(`${key}.`)) {
      changed = true;
      continue;
    }
    const prefix = `${name}.`;
    if (key.startsWith(prefix) && isRecord(value)) {
      const next = withoutSetting(value, key.slice(prefix.length));
      if (next !== value) {
        changed = true;
        if (Object.keys(next).length) entries.push([name, next]);
        continue;
      }
    }
    entries.push([name, value]);
  }
  return changed ? Object.fromEntries(entries) : settings;
}

export function updateConfiguration(
  config: Pick<VscodeConfigAdapter, "snapshot" | "set">,
  key: string,
  value: unknown,
  target: VscodeConfigTarget,
  scope?: ConfigurationUpdateScope,
): void {
  if (!scope || scope.overrideInLanguage === false) {
    config.set(key, value, target);
    return;
  }
  const { languageId } = scope;
  if (!languageId || languageId.includes("[") || languageId.includes("]")) {
    throw new TypeError("Invalid configuration language ID");
  }
  const layer = config.snapshot()[target];
  if (
    scope.overrideInLanguage === undefined &&
    readValue(overrides(layer, languageId), key) === undefined
  ) {
    config.set(key, value, target);
    return;
  }

  const overrideKey = `[${languageId}]`;
  const existing = layer[overrideKey];
  if (value !== undefined) {
    config.set(overrideKey, { ...(isRecord(existing) ? existing : {}), [key]: value }, target);
  } else if (isRecord(existing)) {
    const next = withoutSetting(existing, key);
    if (next !== existing) {
      config.set(overrideKey, Object.keys(next).length ? next : undefined, target);
    }
  }
}
