import { AgentLoop, SupplementaryField } from "@harness/agent-loop";
import { PiCompactionService } from "@harness/pi-compaction";
import { Context } from "@harness/context";
import { inject } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import {
  AssistantMessage,
  ContentMessage,
  MessageMeta,
  TextBlock,
  ToolCallBlock,
  ToolResultMessage,
  FreeformToolDeclaration,
  FunctionToolDeclaration,
  type ContentBlock,
  type Message,
  type ToolDeclaration,
  type ToolGrammar,
} from "@harness/llm";
import { ExtensibleVariants, variant } from "@harness/variants";
import {
  getCurrentScope,
  onScopeDispose,
  shallowReactive,
  shallowReadonly,
  toRaw,
} from "reactivity";
import { z, type ZodType } from "zod";

@variant("core:tool-call:add-tool")
export class AddToolMessage extends ContentMessage {
  declare readonly tool: ToolDeclaration;
}

@variant("core:tool-call:remove-tool")
export class RemoveToolMessage extends ContentMessage {
  declare readonly toolName: string;
}

export interface ToolOutputChunk {
  readonly callId: string;
  readonly delta: string;
}

// Extensible through effect-scoped tool call hooks.
export interface ToolCallHooks {
  readonly streamOutput: HookSlot<ToolOutputChunk>;
  readonly execute: HookSlot<ToolCallInput, Promise<ToolResultMessage>>;
}

export interface ToolCallInput {
  readonly call: ToolCallBlock;
  readonly signal: AbortSignal;
}

export interface ToolExecutionContext {
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly reportOutput?: (delta: string) => void;
}

export type ToolOutput = Promise<readonly ContentBlock[]> | readonly ContentBlock[];

export abstract class ToolDefinition extends ExtensibleVariants {
  declare readonly name: string;

  /** 模型可见声明。 */
  abstract declaration(): ToolDeclaration;

  /** 把本次调用变成具体变体的入参并执行。 */
  abstract invoke(call: ToolCallBlock, ctx: ToolExecutionContext): ToolOutput | Promise<ToolOutput>;
}

function parseInput(parameters: ZodType, call: ToolCallBlock): unknown {
  const parsed = parameters.safeParse(parsedArguments(call));
  if (!parsed.success) {
    throw new Error(`invalid tool arguments: ${parsed.error.message}`);
  }
  return parsed.data;
}

@variant("core:tool-call:tool:zod")
export class ZodToolDefinition<
  TParameters extends ZodType = ZodType,
> extends ToolDefinition {
  declare readonly name: string;
  declare readonly description: string;
  declare readonly parameters: TParameters;
  declare readonly execute: (input: z.infer<TParameters>, ctx: ToolExecutionContext) => ToolOutput;

  declaration(): ToolDeclaration {
    return FunctionToolDeclaration.create({
      name: this.name,
      description: this.description,
      parameters: z.toJSONSchema(this.parameters) as Record<string, unknown>,
    });
  }

  invoke(call: ToolCallBlock, ctx: ToolExecutionContext): ToolOutput {
    return this.execute(parseInput(this.parameters, call) as z.infer<TParameters>, ctx);
  }
}

@variant("core:tool-call:tool:freeform")
export class FreeformToolDefinition extends ToolDefinition {
  declare readonly description: string;
  declare readonly grammar?: ToolGrammar;
  declare readonly execute: (input: string, ctx: ToolExecutionContext) => ToolOutput;

  declaration(): ToolDeclaration {
    return FreeformToolDeclaration.create({
      name: this.name,
      description: this.description,
      grammar: this.grammar,
    });
  }

  invoke(call: ToolCallBlock, ctx: ToolExecutionContext): ToolOutput {
    return this.execute(call.arguments, ctx);
  }
}

export function functionTool<TParameters extends ZodType = ZodType>(options: {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  execute(input: z.infer<TParameters>, ctx: ToolExecutionContext): ToolOutput;
}): ToolDefinition {
  return new ZodToolDefinition<TParameters>(options);
}

export function freeformTool(options: {
  readonly name: string;
  readonly description: string;
  readonly grammar?: ToolGrammar;
  execute(input: string, ctx: ToolExecutionContext): ToolOutput;
}): ToolDefinition {
  return new FreeformToolDefinition(options);
}

function parsedArguments(call: ToolCallBlock): unknown {
  try {
    return call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch (error) {
    throw new Error(`invalid tool arguments: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeErrorResult(call: ToolCallBlock, text: string): ToolResultMessage {
  return ToolResultMessage.create({
    toolCallId: call.id,
    toolName: call.name,
    content: [TextBlock.create({ text })],
    isError: true,
  });
}

function deduplicateToolMessages(messages: readonly Message[]): Message[] {
  const firstByTool = new Map<string, AddToolMessage | RemoveToolMessage>();
  const lastIndexByTool = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!(msg instanceof AddToolMessage) && !(msg instanceof RemoveToolMessage)) continue;
    const name = msg instanceof AddToolMessage ? msg.tool.name : msg.toolName;
    if (!firstByTool.has(name)) firstByTool.set(name, msg);
    lastIndexByTool.set(name, i);
  }

  return messages.filter((msg, i) => {
    if (!(msg instanceof AddToolMessage) && !(msg instanceof RemoveToolMessage)) return true;
    const name = msg instanceof AddToolMessage ? msg.tool.name : msg.toolName;
    if (lastIndexByTool.get(name) !== i) return false;
    return !(firstByTool.get(name) instanceof AddToolMessage && msg instanceof RemoveToolMessage);
  });
}

function reorderToolResults(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  for (let i = 0; i < messages.length;) {
    const current = messages[i++]!;
    result.push(current);
    if (!(current instanceof AssistantMessage)) continue;

    const callIds = current.content
      .filter((b): b is ToolCallBlock => b instanceof ToolCallBlock)
      .map((b) => b.id);
    if (callIds.length === 0) continue;

    const expectedSet = new Set(callIds);
    const byCallId = new Map<string, ToolResultMessage[]>();
    const others: Message[] = [];

    while (i < messages.length && !(messages[i] instanceof AssistantMessage)) {
      const msg = messages[i++]!;
      if (msg instanceof ToolResultMessage && expectedSet.has(msg.toolCallId)) {
        const list = byCallId.get(msg.toolCallId) ?? [];
        list.push(msg);
        byCallId.set(msg.toolCallId, list);
      } else {
        others.push(msg);
      }
    }

    for (const id of callIds) {
      const list = byCallId.get(id);
      if (list) result.push(...list);
    }
    result.push(...others);
  }
  return result;
}

export class ToolCallService {
  readonly hooks: ToolCallHooks = {
    streamOutput: new HookSlot<ToolOutputChunk>(),
    execute: new HookSlot<ToolCallInput, Promise<ToolResultMessage>>(),
  };

  readonly #tools = shallowReactive<ToolDefinition[]>([]);
  readonly tools: readonly ToolDefinition[] = shallowReadonly(this.#tools);

  useTool(tool: ToolDefinition): void {
    if (getCurrentScope()?.active !== true) {
      throw new Error("ToolCallService.useTool() must be called within an active EffectScope");
    }
    const name = tool.name;
    if (toRaw(this.#tools).some((registered) => registered.name === name)) {
      throw new Error(`tool '${name}' is already registered`);
    }
    onScopeDispose(() => {
      const index = toRaw(this.#tools).indexOf(tool);
      if (index >= 0) this.#tools.splice(index, 1);
    });
    this.#tools.push(tool);
  }

  execute(
    calls: readonly ToolCallBlock[],
    signal: AbortSignal = AbortSignal.any([]),
  ): Promise<readonly ToolResultMessage[]> {
    return Promise.all(
      calls.map(async (call) => {
        try {
          return await this.hooks.execute.run({ call, signal }, (input) =>
            this.executeOne(input.call, input.signal),
          );
        } catch (error) {
          return makeErrorResult(call, formatError(error));
        }
      }),
    );
  }

  protected async executeOne(call: ToolCallBlock, signal: AbortSignal): Promise<ToolResultMessage> {
    if (signal.aborted) {
      return makeErrorResult(call, "Operation aborted");
    }
    const tool = this.tools.find((candidate) => candidate.name === call.name);
    if (tool === undefined) {
      return makeErrorResult(call, `Tool ${call.name} not found`);
    }
    let reporting = true;
    const ctx: ToolExecutionContext = {
      callId: call.id,
      signal,
      reportOutput: (delta) => {
        if (reporting && !signal.aborted) this.hooks.streamOutput.run({ callId: call.id, delta });
      },
    };
    try {
      const result = await tool.invoke(call, ctx);
      return ToolResultMessage.create({
        toolCallId: call.id,
        toolName: call.name,
        content: [...result],
        isError: false,
      });
    } catch (error) {
      return makeErrorResult(call, formatError(error));
    } finally {
      reporting = false;
    }
  }
}

export function useToolCall(): void {
  const toolCall = inject(ToolCallService);
  const context = inject(Context);
  const loop = inject(AgentLoop);

  context.hooks.batch.use((messages, next) => next(deduplicateToolMessages(messages)));

  loop.hooks.transformContext.use(async (_input, next) => {
    const payload = await next();
    const activeTools = new Map<string, ToolDeclaration>();
    const conversation: Message[] = [];
    for (const msg of payload.messages) {
      if (msg instanceof AddToolMessage) {
        activeTools.set(msg.tool.name, msg.tool);
      } else if (msg instanceof RemoveToolMessage) {
        activeTools.delete(msg.toolName);
      } else {
        conversation.push(msg);
      }
    }
    const desiredTools = toolCall.tools.map((tool) => tool.declaration());
    const desiredMap = new Map(desiredTools.map((tool) => [tool.name, tool]));
    for (const tool of desiredTools) {
      const existing = activeTools.get(tool.name);
      if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(tool)) {
        context.pending.push(
          AddToolMessage.create({
            tool,
            content: [TextBlock.create({ text: JSON.stringify(tool) })],
            meta: new MessageMeta().set(SupplementaryField, true),
          }),
        );
      }
    }
    for (const name of activeTools.keys()) {
      if (!desiredMap.has(name)) {
        context.pending.push(
          RemoveToolMessage.create({
            toolName: name,
            content: [],
            meta: new MessageMeta().set(SupplementaryField, true),
          }),
        );
      }
    }
    const messages = reorderToolResults(conversation);
    return {
      ...payload,
      messages,
      tools:
        desiredTools.length > 0
          ? payload.tools
            ? [...payload.tools, ...desiredTools]
            : desiredTools
          : payload.tools,
    };
  });

  loop.hooks.handleOutput.use(async ({ response, signal }, next) => {
    const calls = response.message.content.filter(
      (block): block is ToolCallBlock => block instanceof ToolCallBlock,
    );
    if (calls.length > 0) {
      const results = await toolCall.execute(calls, signal);
      context.pending.push(...results);
    }
    await next();
  });
}

export function useToolCallCompaction(): void {
  const compaction = inject(PiCompactionService);
  const toolCall = inject(ToolCallService);

  compaction.hooks.compact.use(async (input, next) => {
    const activeByTool = new Map<string, AddToolMessage>();
    const messages: Message[] = [];
    for (const msg of input.messages) {
      if (msg instanceof AddToolMessage) {
        activeByTool.set(msg.tool.name, msg);
      } else if (msg instanceof RemoveToolMessage) {
        activeByTool.delete(msg.toolName);
      } else {
        messages.push(msg);
      }
    }
    const registered = new Set(toolCall.tools.map((tool) => tool.name));
    for (const name of activeByTool.keys()) {
      if (!registered.has(name)) {
        activeByTool.delete(name);
      }
    }
    const compacted = await next({ ...input, messages });
    return activeByTool.size > 0 ? [...compacted, ...activeByTool.values()] : compacted;
  });
}
