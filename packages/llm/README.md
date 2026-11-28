```ts
abstract class LlmProvider {
  abstract readonly models: readonly LlmModelInfo[];
  abstract stream(request: LlmRequest): LlmStream;
}

class LlmService {
  readonly models: readonly LlmModelInfo[]; // 响应式聚合所有 Provider 子 Scope 中的模型列表
  canSend(messages: readonly Message[]): boolean; // 判断消息序列是否包含可触发响应的输入且所有 toolCall 已闭合
  stream(request: LlmRequest): LlmStream; // 发起流式请求（支持通过 .result() 获取完整响应）
  webSearch(request: WebSearchRequest): Promise<readonly WebSearchResultItem[]>; // 委派给 Provider 子 Scope；Provider 不支持时抛错
}

interface WebSearchRequest {
  readonly provider: string;
  readonly query: string;
  readonly signal?: AbortSignal;
}

interface WebSearchResultItem {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

interface WebSearchProvider {
  webSearch(request: WebSearchRequest): Promise<readonly WebSearchResultItem[]>; // 可扩展：Provider 实现此接口即可被 LlmService.webSearch 使用
}

interface LlmModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly reasoning: boolean | readonly string[];
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly freeformSyntaxes?: readonly string[]; // 原生接受的 grammar 语法；缺省表示只能收 function 工具
  readonly systemPromptUpdate?: "in-history" | "leading-only"; // 缺省时在头部发送最终 SP
}

abstract class Modality extends ExtensibleVariants {}
class TextModality extends Modality {}
class ImageModality extends Modality {
  readonly maxCountPerRequest?: number;
  readonly maxBytesPerItem?: number;
}
class VideoModality extends Modality {
  readonly maxCountPerRequest?: number;
  readonly maxBytesPerItem?: number;
  readonly maxDurationMs?: number;
}
class AudioModality extends Modality {
  readonly maxCountPerRequest?: number;
  readonly maxBytesPerItem?: number;
  readonly maxDurationMs?: number;
}
class PdfModality extends Modality {
  readonly maxCountPerRequest?: number;
  readonly maxBytesPerItem?: number;
  readonly maxPages?: number;
}

abstract class ToolDeclaration extends ExtensibleVariants {
  readonly name: string;
  readonly description: string;
}
class FunctionToolDeclaration extends ToolDeclaration {
  readonly parameters: Record<string, unknown>;
}
interface ToolGrammar {
  readonly syntax: string;
  readonly definition: string;
}
class FreeformToolDeclaration extends ToolDeclaration {
  readonly grammar?: ToolGrammar;
}


abstract class ContentBlock extends ExtensibleVariants {}
class TextBlock extends ContentBlock {
  readonly text: string;
}
class ThinkingBlock extends ContentBlock {
  readonly thinking: string;
  readonly signature?: string;
  readonly redacted?: boolean;
}
abstract class MediaBlock extends ContentBlock {
  readonly mimeType: string;
  readonly data?: string;
  readonly url?: string;
  readonly fileId?: string;
  readonly filename?: string;
}
class ImageBlock extends MediaBlock {
  readonly width?: number;
  readonly height?: number;
  readonly detail?: "auto" | "low" | "high" | "original";
}
class VideoBlock extends MediaBlock {
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}
class AudioBlock extends MediaBlock {
  readonly durationMs?: number;
}
class DocumentBlock extends MediaBlock {
  readonly title?: string;
  readonly pageCount?: number;
  readonly purpose?: string;
}
class ToolCallBlock extends ContentBlock {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly thoughtSignature?: string;
}

class MessageMeta extends ExtensibleFields {}

abstract class Message extends ExtensibleVariants<{
  readonly id?: string;
  readonly meta?: MessageMeta;
}> {
  readonly id: string;
  readonly meta: MessageMeta;
}

abstract class ContentMessage extends Message {
  readonly content: readonly ContentBlock[];
}

class SystemMessage extends ContentMessage {
  readonly sectionId?: string; // 同一 ID 写入或替换该段，空 content 撤回，省略 ID 时追加到基础 SP
}

function snapshotSystemPrompt(messages: readonly SystemMessage[]): readonly SystemMessage[]; // 保留切点的基础提示词与有效 section

class DeveloperMessage extends ContentMessage {}
class UserMessage extends ContentMessage {}
class AssistantMessage extends ContentMessage {
  readonly provider: string;
  readonly model: string;
  readonly replayState?: unknown;
}
class ToolResultMessage extends ContentMessage {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError?: boolean;
}

function mergeStreamChunk(
  message: AssistantMessage | undefined,
  chunk: LlmChunk,
): AssistantMessage | undefined; // 将流式 chunk 合并到 AssistantMessage
```
