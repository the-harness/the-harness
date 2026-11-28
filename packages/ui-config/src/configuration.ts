export interface ConfigurationSnapshot {
  readonly defaults: Record<string, unknown>;
  readonly user: Record<string, unknown>;
  readonly workspace: Record<string, unknown>;
}

export function readValue(values: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(values, key)) return values[key];
  const parts = key.split(".");
  for (let end = parts.length - 1; end > 0; end--) {
    let value = values[parts.slice(0, end).join(".")];
    for (const part of parts.slice(end)) {
      value =
        value !== null && typeof value === "object"
          ? (value as Record<string, unknown>)[part]
          : undefined;
    }
    if (value !== undefined) return value;
  }
  const result: Record<string, unknown> = {};
  const prefix = key ? `${key}.` : "";
  for (const fullKey of Object.keys(values)) {
    if (!fullKey.startsWith(prefix)) continue;
    const name = fullKey.slice(prefix.length).split(".")[0]!;
    if (!Object.hasOwn(result, name)) result[name] = readValue(values, `${prefix}${name}`);
  }
  return Object.keys(result).length ? result : undefined;
}

function mergeValues(left: unknown, right: unknown): unknown {
  if (right === undefined) return left;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return right;
  const merged = { ...left } as Record<string, unknown>;
  for (const [key, value] of Object.entries(right)) merged[key] = mergeValues(merged[key], value);
  return merged;
}

function groupedOverrides(
  layer: Record<string, unknown>,
  language: string,
): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(layer))
    if (
      key.startsWith("[") &&
      key !== `[${language}]` &&
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      [...key.matchAll(/\[([^\]]+)\]/g)].some((match) => match[1] === language)
    ) {
      result = mergeValues(result, entry) as Record<string, unknown>;
    }
  return result;
}

function singleLanguageOverrides(
  layer: Record<string, unknown>,
  language: string,
): Record<string, unknown> {
  const entry = layer[`[${language}]`];
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : {};
}

export function overrides(
  layer: Record<string, unknown>,
  language: string,
): Record<string, unknown> {
  return mergeValues(
    groupedOverrides(layer, language),
    singleLanguageOverrides(layer, language),
  ) as Record<string, unknown>;
}

export function resolveConfiguration(
  snapshot: ConfigurationSnapshot,
  key: string,
  languageId?: string,
): unknown {
  const layers = [snapshot.defaults, snapshot.user, snapshot.workspace];
  const base = layers.reduce<unknown>(
    (value, layer) => mergeValues(value, readValue(layer, key)),
    undefined,
  );
  if (!languageId) return base;
  const grouped = layers.reduce(
    (value, layer) => mergeValues(value, readValue(groupedOverrides(layer, languageId), key)),
    base,
  );
  return layers.reduce(
    (value, layer) =>
      mergeValues(value, readValue(singleLanguageOverrides(layer, languageId), key)),
    grouped,
  );
}
