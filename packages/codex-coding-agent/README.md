```ts
interface CodexCodingAgentOptions {
  readonly instructions?: string; // 覆盖 codex 基础指令
  readonly developerInstructions?: string; // 追加到基础指令之后
  readonly compactPrompt?: string; // 覆盖压缩触发消息
  readonly updatePlan?: boolean; // 注册 update_plan 工具并保留基础指令中的计划段落，默认 false
  readonly viewImage?: boolean; // 注册 view_image 工具，默认 true
  readonly webSearch?: boolean; // 注册 web_search 工具，默认 true
  readonly includePermissionsInstructions?: boolean; // 注入 `<permissions instructions>`，默认 true
  readonly includeCollaborationMode?: boolean; // 注入 `<collaboration_mode>`，默认 true
  readonly includeEnvironmentContext?: boolean; // 注入 `<environment_context>`，默认 true
  readonly includeEnvironmentContextTime?: boolean; // 注入日期与时区，默认 true
  readonly approvalPolicy?: "on-request" | "never"; // 默认 "never"
  readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access"; // 默认 "danger-full-access"
  readonly networkAccess?: boolean; // 默认 true
  readonly writableRoots?: readonly string[];
  readonly projectDocMaxBytes?: number; // 项目 AGENTS.md 字节预算，默认 32768，0 表示禁用
  readonly registerTools?: boolean; // 注册 codex 自带工具与 MCP，默认 true
  readonly automaticPromptUpdates?: boolean; // 系统段落的增量更新，默认 true
  readonly autoCompactTokenLimit?: number; // 自动压缩阈值，上限为模型上下文窗口的 90%
}

class CodexCodingAgentPreset extends AgentPreset {
  readonly options?: CodexCodingAgentOptions;
  setup(): void; // 在 agent scope 中装配 codex 的 prompt、AGENTS.md 上下文、工具与压缩
}

function useCodexCodingAgentPreset(options?: CodexCodingAgentOptions): void; // 在当前 EffectScope 中向 AgentPresetRegistry 注册 codex preset
```
