```ts
const SUMMARIZATION_PROMPT: string; // codex 压缩触发消息（`prompts/templates/compact/prompt.md` 原文）
const SUMMARY_PREFIX: string; // codex 摘要前缀（`prompts/templates/compact/summary_prefix.md` 原文）

function formatCodexSummary(summary: string): string; // `${SUMMARY_PREFIX}\n${summary}`

class CodexCompactionSummaryMessage extends UserMessage {
  readonly from: number;
  readonly to: number;
  readonly summary?: string;
  readonly usage?: LlmUsage;
}

interface CodexCompactionOptions {
  readonly baseInstructions?: () => string | undefined; // 摘要请求的 system prompt
  readonly compactPrompt?: string; // 覆盖默认的 SUMMARIZATION_PROMPT 触发消息
  readonly keepRecentUserTokens?: number; // 压缩后保留的最近真实用户消息 token 预算，默认 20000
  readonly maxTokens?: number; // useCodexCompaction 的自动压缩阈值
}

class CodexCompactionService extends PiCompactionService {} // 压缩整个活动窗口，输出保留的用户消息 + codex 摘要消息

function useCodexCompaction(options?: CodexCompactionOptions): void; // 在当前 EffectScope 中挂载 codex 自动压缩
```
