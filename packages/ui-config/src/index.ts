import { inject } from "@harness/di";
import { CrossTabSync, UiStorageService } from "@harness/ui-storage";
import { ExtensibleFields, type FieldKey } from "@harness/variants";
import { getCurrentScope, onScopeDispose, shallowReactive, watch } from "vue";
import { z } from "zod";

export const ConfigStages = {
  Defaults: Symbol("config:defaults"),
  Preset: Symbol("config:preset"),
  User: Symbol("config:user"),
  Workspace: Symbol("config:workspace"),
  Session: Symbol("config:session"),
} as const;

// FIXME: 去掉硬编码的默认阶段顺序
export const DEFAULT_STAGE_ORDER: readonly symbol[] = [
  ConfigStages.Defaults,
  ConfigStages.Preset,
  ConfigStages.User,
  ConfigStages.Workspace,
  ConfigStages.Session,
];

export class Config extends ExtensibleFields {}

export function createStorageConfigLayer(
  storage: UiStorageService,
  scope: readonly string[],
  storageKey: string,
): Config {
  const state = storage.scope(...scope).use(
    storageKey,
    {
      values: z.record(z.string(), z.unknown()).default({}),
    },
    new CrossTabSync(),
  );
  const layer = ExtensibleFields.deserialize.call(Config, state.values);
  watch(
    () => state.values,
    (next) => {
      const deserialized = ExtensibleFields.deserialize.call(Config, next);
      for (const [key] of ExtensibleFields.entries(layer)) {
        if (!deserialized.has(key as never)) layer.delete(key as never);
      }
      for (const [key, value] of ExtensibleFields.entries(deserialized)) {
        layer.set(key as never, value);
      }
    },
  );
  const originalSet = layer.set.bind(layer);
  layer.set = (key, value) => {
    originalSet(key, value);
    state.values = ExtensibleFields.serialize(layer);
    return layer;
  };
  const originalDelete = layer.delete.bind(layer);
  layer.delete = (key) => {
    const deleted = originalDelete(key);
    if (deleted) state.values = ExtensibleFields.serialize(layer);
    return deleted;
  };
  return layer;
}

interface LayerEntry {
  readonly layer: Config;
  readonly stage?: symbol;
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
  ) {
    return right;
  }
  const merged = { ...left } as Record<string, unknown>;
  for (const [key, value] of Object.entries(right)) {
    merged[key] = mergeValues(merged[key], value);
  }
  return merged;
}

export class UiConfigService extends Config {
  private readonly parent = inject(UiConfigService, { optional: true });
  private readonly stageOrder: readonly symbol[];
  private readonly entries = shallowReactive<LayerEntry[]>([]);

  constructor(stageOrder?: readonly symbol[]) {
    super();
    this.stageOrder = stageOrder ?? this.parent?.stageOrder ?? DEFAULT_STAGE_ORDER;
    if (!this.parent) {
      const storage = inject(UiStorageService, { optional: true });
      if (storage) {
        this.entries.push({
          layer: createStorageConfigLayer(storage, ["config", "user"], "core:ui-config"),
          stage: ConfigStages.User,
        });
      }
    }
  }

  useLayer(layer: Config, stage?: symbol): void {
    if (!getCurrentScope()?.active) {
      throw new Error("useLayer() requires an active EffectScope");
    }
    const entry: LayerEntry = { layer, stage };
    onScopeDispose(() => {
      const index = this.entries.indexOf(entry);
      if (index !== -1) this.entries.splice(index, 1);
    });
    this.entries.push(entry);
  }

  private collectEntries(): LayerEntry[] {
    const all = this.parent ? [...this.parent.collectEntries(), ...this.entries] : [...this.entries];
    if (!this.stageOrder.length) return all;
    const rank = new Map(this.stageOrder.map((stage, index) => [stage, index]));
    return all
      .map((entry, index) => ({
        entry,
        index,
        order: entry.stage !== undefined ? (rank.get(entry.stage) ?? this.stageOrder.length) : this.stageOrder.length,
      }))
      .sort((a, b) => a.order - b.order || a.index - b.index)
      .map((item) => item.entry);
  }

  override has<TValue>(key: FieldKey<this, TValue>): boolean {
    return this.collectEntries().some(({ layer }) => layer.has(key as FieldKey<Config, TValue>));
  }

  override get<TValue>(key: FieldKey<this, TValue>): TValue | undefined {
    let result: unknown;
    for (const { layer } of this.collectEntries()) {
      const next = layer.get(key as FieldKey<Config, TValue>);
      if (next !== undefined) result = mergeValues(result, next);
    }
    return result as TValue | undefined;
  }
}
