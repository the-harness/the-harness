```ts
interface PiCodingAgentOptions {
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string;
}

class PiCodingAgentPreset extends AgentPreset {
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string;
  setup(
    readSections?: () => Readonly<Record<string, string>>,
    options?: {
      readonly automaticPromptUpdates?: boolean;
      readonly registerTools?: boolean; // 默认注册 Pi 内置工具与 MCP；关闭后由调用方通过 useTool 装配
    },
  ): (messages: readonly Message[]) => readonly SystemMessage[]; // 关闭自动更新后由调用方提交返回的 SP 变更
}

function createPiPromptSection(sectionId: string, text?: string): SystemMessage; // 创建由 Pi preset 管理的 section 更新或撤回

usePiCodingAgentPreset(options?: PiCodingAgentOptions): void // 在当前 EffectScope 中向 AgentPresetRegistry 注册 pi-coding-agent preset
```
