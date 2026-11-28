```ts
class AddToolMessage extends ContentMessage {
  readonly tool: ToolDeclaration;
}

class RemoveToolMessage extends ContentMessage {
  readonly toolName: string;
}

interface ToolOutputChunk {
  readonly callId: string;
  readonly delta: string;
}

// 可拓展接口：在 EffectScope 中注册工具调用钩子
interface ToolCallHooks {
  readonly streamOutput: HookSlot<ToolOutputChunk>; // 处理工具执行期间产生的增量输出
  readonly execute: HookSlot<ToolCallInput, Promise<ToolResultMessage>>; // 包裹参数校验与单次调用
}

interface ToolCallInput {
  readonly call: ToolCallBlock;
  readonly signal: AbortSignal;
}

interface ToolExecutionContext {
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly reportOutput?: (delta: string) => void; // 增量报告执行中的输出
}

type ToolOutput = Promise<readonly ContentBlock[]> | readonly ContentBlock[];

abstract class ToolDefinition extends ExtensibleVariants {
  readonly name: string;
  declaration(): ToolDeclaration; // 模型可见声明
  invoke(call: ToolCallBlock, ctx: ToolExecutionContext): ToolOutput | Promise<ToolOutput>; // 解析本次调用并执行
}

class ZodToolDefinition<TParameters extends ZodType = ZodType> extends ToolDefinition {
  readonly description: string;
  readonly parameters: TParameters;
  readonly execute: (input: z.infer<TParameters>, ctx: ToolExecutionContext) => ToolOutput;
}

class FreeformToolDefinition extends ToolDefinition {
  readonly description: string;
  readonly grammar?: ToolGrammar;
  readonly execute: (input: string, ctx: ToolExecutionContext) => ToolOutput;
}

function functionTool<TParameters extends ZodType>(options: { // 只为保住 execute 入参的泛型推导，等价于 new ZodToolDefinition<TParameters>(options)
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  execute(input: z.infer<TParameters>, ctx: ToolExecutionContext): ToolOutput;
}): ToolDefinition;

function freeformTool(options: {
  readonly name: string;
  readonly description: string;
  readonly grammar?: ToolGrammar;
  execute(input: string, ctx: ToolExecutionContext): ToolOutput;
}): ToolDefinition;

// execute 按调用顺序为每条调用返回一条结果，包括失败结果
class ToolCallService {
  readonly hooks: ToolCallHooks;
  readonly tools: readonly ToolDefinition[]; // 响应式只读列表，保留注册顺序
  useTool(tool: ToolDefinition): void; // 在当前 EffectScope 中注册工具
  execute(calls: readonly ToolCallBlock[], signal?: AbortSignal): Promise<readonly ToolResultMessage[]>;
}

useToolCall(): void // 在当前 EffectScope 中挂载工具消息去重、声明与调用钩子
useToolCallCompaction(): void // 在当前 EffectScope 中将工具消息折叠钩子挂载到 CompactionService.hooks.compact
```
