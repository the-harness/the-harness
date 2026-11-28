```ts
interface AgentPresetIcon {
  readonly src: string; // 图片 URL 或 data URL
  readonly monochrome?: boolean; // 为 true 时按透明度作为遮罩，使用当前文字颜色
}

abstract class AgentPreset extends ExtensibleVariants {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: AgentPresetIcon;
  abstract setup(): void; // 在当前 agent EffectScope 中执行装配
}

class AgentPresetRegistry {
  readonly presets: ReadonlyMap<string, AgentPreset>; // 响应式只读视图
  readonly defaultId: string | undefined; // 当前最早注册的 preset ID
  usePreset(preset: AgentPreset): void; // 在当前 EffectScope 中注册，scope dispose 时自动注销
}
```
