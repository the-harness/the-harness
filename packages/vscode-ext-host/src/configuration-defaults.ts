type ConfigurationSection = { properties?: Record<string, { default?: unknown }> };

export function readConfigurationDefaults(
  contributions: Iterable<unknown>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const overrides: Record<string, unknown>[] = [];
  for (const contribution of contributions) {
    const contributes = contribution as
      | {
          configuration?: ConfigurationSection | ConfigurationSection[];
          configurationDefaults?: Record<string, unknown>;
        }
      | undefined;
    const sections = contributes?.configuration;
    for (const section of sections ? [sections].flat() : []) {
      for (const [key, schema] of Object.entries(section.properties ?? {})) {
        if (Object.hasOwn(schema, "default")) defaults[key] = schema.default;
      }
    }
    if (contributes?.configurationDefaults) overrides.push(contributes.configurationDefaults);
  }
  for (const values of overrides) {
    for (const [key, value] of Object.entries(values)) {
      defaults[key] =
        key.startsWith("[") && value && typeof value === "object"
          ? { ...(defaults[key] as Record<string, unknown> | undefined), ...value }
          : value;
    }
  }
  return defaults;
}
