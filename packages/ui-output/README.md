```ts
interface OutputChannelGroup {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

interface OutputChannel {
  readonly id: string;
  readonly name: string;
  readonly group?: OutputChannelGroup;
  readonly lines: readonly string[];
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
}

class UiOutputService {
  readonly menu: Menu<OutputMenuContext, "clipboard" | "output">; // 输出内容的上下文菜单，贡献随注册 scope 释放
  readonly channels: ComputedRef<readonly OutputChannel[]>;
  readonly activeChannelId: Ref<string | null>;
  useChannel(name: string, group?: OutputChannelGroup, identity?: string): OutputChannel; // 随 EffectScope 释放。独立 identity 允许同组的同名频道。
}

interface OutputMenuContext {
  readonly channelId: string;
  readonly selection: string; // 打开时捕获的选区
  readonly selectAll: () => void; // 当前输出视图的全选动作
}
```
