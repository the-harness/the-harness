import { ExtensibleVariants } from "@harness/variants";
import { getCurrentScope, onScopeDispose, shallowReactive, shallowReadonly } from "reactivity";

export interface AgentPresetIcon {
  readonly src: string;
  readonly monochrome?: boolean;
}

export abstract class AgentPreset extends ExtensibleVariants {
  declare readonly id: string;
  declare readonly name: string;
  declare readonly description?: string;
  declare readonly icon?: AgentPresetIcon;

  abstract setup(): void;
}

export class AgentPresetRegistry {
  readonly #presets = shallowReactive(new Map<string, AgentPreset>());

  get presets(): ReadonlyMap<string, AgentPreset> {
    return shallowReadonly(this.#presets);
  }

  get defaultId(): string | undefined {
    return this.#presets.keys().next().value;
  }

  usePreset(preset: AgentPreset): void {
    if (getCurrentScope()?.active !== true) {
      throw new Error("usePreset() requires an active EffectScope");
    }
    const { id } = preset;
    if (this.#presets.has(id)) {
      throw new Error(`agent preset '${id}' is already registered`);
    }
    onScopeDispose(() => {
      if (this.#presets.get(id) === preset) {
        this.#presets.delete(id);
      }
    });
    this.#presets.set(id, preset);
  }
}
