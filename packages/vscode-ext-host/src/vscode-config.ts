import { Config, ConfigStages, type UiConfigService } from "@harness/ui-config";
import { resolveConfiguration, type ConfigurationSnapshot } from "@harness/ui-config/configuration";
import { getCurrentScope, onScopeDispose, reactive, shallowReactive } from "vue";

export type VscodeConfigTarget = "user" | "workspace";

export const VscodeSettingsField = Config.defineField<Record<string, unknown>>(
  "harness:vscode-ext-host:settings",
);

export class VscodeConfigAdapter {
  private readonly defaultLayers = shallowReactive(new Set<Config>());
  private readonly userValues = reactive<Record<string, unknown>>({});
  private readonly workspaceValues = reactive<Record<string, unknown>>({});
  private readonly userLayer = new Config();
  private readonly workspaceLayer = new Config();

  constructor(config: UiConfigService) {
    this.userLayer.set(VscodeSettingsField, this.userValues);
    this.workspaceLayer.set(VscodeSettingsField, this.workspaceValues);
    config.useLayer(this.userLayer, ConfigStages.User);
    config.useLayer(this.workspaceLayer, ConfigStages.Workspace);
  }

  useDefaults(defaults: Record<string, unknown>): void {
    if (!getCurrentScope()?.active) {
      throw new Error("useDefaults() requires an active EffectScope");
    }
    const layer = new Config();
    layer.set(VscodeSettingsField, { ...defaults });
    onScopeDispose(() => {
      this.defaultLayers.delete(layer);
    });
    this.defaultLayers.add(layer);
  }

  snapshot(): ConfigurationSnapshot {
    const defaults: Record<string, unknown> = {};
    for (const layer of this.defaultLayers) {
      Object.assign(defaults, layer.get(VscodeSettingsField));
    }
    return {
      defaults,
      user: { ...this.userValues },
      workspace: { ...this.workspaceValues },
    };
  }

  get<T = unknown>(key: string, defaultValue?: T, languageId?: string): T | undefined {
    const result = resolveConfiguration(this.snapshot(), key, languageId);
    return result === undefined ? defaultValue : (result as T);
  }

  set(key: string, value: unknown, target: VscodeConfigTarget = "user"): void {
    const values = target === "workspace" ? this.workspaceValues : this.userValues;
    if (value === undefined) delete values[key];
    else values[key] = value;
  }
}
