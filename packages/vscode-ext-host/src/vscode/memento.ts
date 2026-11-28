import type { ExtHostBridge } from "./bridge.ts";

export async function createMemento(
  bridge: ExtHostBridge,
  extensionId: string,
  scope: "global" | "workspace",
) {
  let values =
    ((await bridge.callMain("memento.load", extensionId, scope)) as
      | Record<string, unknown>
      | undefined) ?? {};
  return {
    keys: () => Object.keys(values),
    get<T>(key: string, defaultValue?: T): T | undefined {
      return Object.hasOwn(values, key) ? (values[key] as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      const copy = value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
      const next = { ...values };
      if (copy === undefined) delete next[key];
      else next[key] = copy;
      values = next;
      await bridge.callMain("memento.update", extensionId, scope, key, copy, value === undefined);
    },
  };
}
