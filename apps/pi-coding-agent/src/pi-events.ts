import { setTimeout as delay } from "node:timers/promises";
import { isRetryableAssistantError, retryDelayMs, type RetryPolicy } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import type { LlmChunk, LlmResponse, ToolResultMessage } from "@harness/llm";
import {
  fromPiAssistant,
  parseToolInput,
  piUsage,
  replacePiToolResult,
  stampResponse,
  toPiMessages,
  type PiAssistant,
  type PiMessage,
} from "./extension-content.ts";

type AssistantUpdate = Extract<
  AgentSessionEvent,
  { type: "message_update" }
>["assistantMessageEvent"];
type ToolResult = Extract<PiMessage, { role: "toolResult" }>;
export type TurnInputMessage = Extract<PiMessage, { role: "system" | "user" | "custom" }>;

export interface PersistedTurn {
  readonly turnIndex: number;
  readonly message: PiAssistant;
  readonly toolResults: ToolResult[];
  readonly messageEntryId: string;
  readonly toolResultEntryIds: string[];
}

type BeforeTurnEnd = (turn: PersistedTurn) => Promise<void>;
type SummaryAttemptStart = Extract<
  AgentSessionEvent,
  { type: "summarization_retry_attempt_start" }
>;

export type RetrySummary = <T>(
  start: SummaryAttemptStart,
  signal: AbortSignal,
  summarize: () => Promise<T>,
) => Promise<T>;

export class PiEvents {
  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly backpressure = new Set<() => Promise<void>>();
  private readonly newMessages: PiMessage[] = [];
  private current?: PiAssistant;
  private messageEntryId?: string;
  private open?: { readonly kind: "thinking" | "text"; readonly index: number };
  private finalized = false;
  private assistantStarted = false;
  private turnIndex = 0;
  private extensionEvents = Promise.resolve();

  constructor(
    private readonly project: (message: PiMessage, nativeId?: string) => string | undefined,
    private readonly getRunner: () => ExtensionRunner | undefined,
  ) {}

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeBackpressure(listener: () => Promise<void>): () => void {
    this.backpressure.add(listener);
    return () => this.backpressure.delete(listener);
  }

  async flush(): Promise<void> {
    await this.flushExtensionEvents();
    for (const listener of this.backpressure) await listener();
  }

  async flushExtensionEvents(): Promise<void> {
    await this.extensionEvents;
  }

  async retrySummarization<T>(
    start: SummaryAttemptStart,
    model: { id: string; provider: string; api: PiAssistant["api"] },
    policy: RetryPolicy,
    signal: AbortSignal,
    summarize: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        try {
          return await summarize();
        } catch (error) {
          signal.throwIfAborted();
          if (!policy.enabled || attempt >= policy.maxRetries) throw error;
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (
            !isRetryableAssistantError({
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage,
              model: model.id,
              provider: model.provider,
              api: model.api,
              timestamp: Date.now(),
              usage: piUsage(),
            })
          )
            throw error;

          const delayMs = retryDelayMs(policy, ++attempt);
          this.emit({
            type: "summarization_retry_scheduled",
            attempt,
            maxAttempts: policy.maxRetries,
            delayMs,
            errorMessage,
          });
          await delay(delayMs, undefined, { signal });
          this.emit(start);
        }
      }
    } finally {
      if (attempt > 0) this.emit({ type: "summarization_retry_finished" });
    }
  }

  emit(event: AgentSessionEvent, extensionHandled = false): void {
    if (event.type === "message_end") this.newMessages.push(event.message);
    const runner = this.getRunner();
    if (runner && !extensionHandled) {
      if (event.type === "message_end" && runner.hasHandlers("message_end")) {
        const snapshot = structuredClone(event);
        this.extensionEvents = this.extensionEvents.then(async () => {
          await runner.emitMessageEnd(snapshot);
        });
      }
      const isToolEvent =
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end";
      if (
        (event.type === "message_start" ||
          event.type === "message_update" ||
          (isToolEvent && event.parentToolCallId === undefined)) &&
        runner.hasHandlers(event.type)
      ) {
        // Stream updates share the assistant object that the next chunk will change.
        const snapshot =
          event.type === "message_update" || event.type === "message_start"
            ? structuredClone(event)
            : event;
        this.extensionEvents = this.extensionEvents.then(async () => {
          await runner.emit(snapshot);
        });
      }
    }
    for (const listener of this.listeners) listener(event);
  }

  async start(): Promise<void> {
    this.newMessages.length = 0;
    this.turnIndex = 0;
    await this.getRunner()?.emit({ type: "agent_start" });
    this.emit({ type: "agent_start" });
  }

  async prepareTurn(): Promise<void> {
    await this.extensionEvents;
    await this.getRunner()?.emit({
      type: "turn_start",
      turnIndex: this.turnIndex++,
      timestamp: Date.now(),
    });
  }

  startTurn(model: { id: string; provider: string; api: PiAssistant["api"] }): void {
    this.current = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "pending",
      timestamp: Date.now(),
      usage: piUsage(),
    };
    this.open = undefined;
    this.messageEntryId = undefined;
    this.finalized = false;
    this.assistantStarted = false;
    this.emit({ type: "turn_start" });
  }

  setRequestModel(model: { id: string; provider: string; api: PiAssistant["api"] }): void {
    if (this.current)
      this.current = { ...this.current, model: model.id, provider: model.provider, api: model.api };
  }

  async editTurnInput(message: TurnInputMessage): Promise<TurnInputMessage> {
    const runner = this.getRunner();
    if (!runner) return message;
    await this.flushExtensionEvents();
    if (runner.hasHandlers("message_start")) {
      await runner.emit({ type: "message_start", message: structuredClone(message) });
    }
    if (!runner.hasHandlers("message_end")) return message;
    const replacement = await runner.emitMessageEnd({ type: "message_end", message });
    if (replacement?.role !== message.role) return message;
    if (replacement?.role === "system") return replacement;
    if (replacement?.role === "user" || replacement?.role === "custom") {
      return { ...replacement, content: replacement.content ?? [] };
    }
    return message;
  }

  publishTurnInput(message: TurnInputMessage, final: TurnInputMessage): void {
    this.emit({ type: "message_start", message }, true);
    this.emit({ type: "message_end", message: final }, true);
  }

  chunk(chunk: LlmChunk): void {
    const assistant = this.current;
    if (!assistant || this.finalized) return;
    if (chunk.type === "finish") {
      const reason = chunk.response.stopReason;
      if (reason === "error" || reason === "aborted" || reason === "max_tokens") {
        stampResponse(chunk.response, assistant.timestamp);
        const [message] = toPiMessages([chunk.response.message]);
        if (message?.role === "assistant") this.finalize(message, chunk.response.message.id);
      }
      return;
    }

    this.startAssistant(assistant);
    if (chunk.type === "text_delta" || chunk.type === "thinking_delta") {
      this.textDelta(assistant, chunk.type === "text_delta" ? "text" : "thinking", chunk.delta);
      return;
    }
    if (chunk.type === "tool_call_start") {
      this.closeText(assistant);
      const contentIndex = assistant.content.length;
      assistant.content.push({ type: "toolCall", id: chunk.id, name: chunk.name, arguments: {} });
      this.delta(assistant, { type: "toolcall_start", contentIndex, partial: assistant });
      return;
    }
    const contentIndex = assistant.content.findIndex(
      (block) => block.type === "toolCall" && block.id === chunk.id,
    );
    if (contentIndex === -1) return;
    if (chunk.type === "tool_call_delta") {
      this.delta(assistant, {
        type: "toolcall_delta",
        contentIndex,
        delta: chunk.delta,
        partial: assistant,
      });
    } else {
      const toolCall = {
        type: "toolCall" as const,
        id: chunk.id,
        name: chunk.name,
        arguments: parseToolInput(chunk.arguments) ?? {},
      };
      assistant.content[contentIndex] = toolCall;
      this.delta(assistant, { type: "toolcall_end", contentIndex, toolCall, partial: assistant });
    }
  }

  async finishMessage(response: LlmResponse): Promise<LlmResponse> {
    const assistant = this.current;
    if (!assistant || this.finalized) return response;
    stampResponse(response, assistant.timestamp);
    const [message] = toPiMessages([response.message]);
    if (message?.role !== "assistant") return response;
    this.startAssistant(assistant);
    this.closeText(assistant);
    await this.extensionEvents;
    const replacement = await this.getRunner()?.emitMessageEnd({ type: "message_end", message });
    if (replacement?.role === "assistant") {
      const edited = { ...replacement, content: replacement.content ?? [] };
      const native = fromPiAssistant(edited, response.message);
      this.finalize(edited, native.id, true);
      return { ...response, message: native };
    }
    this.finalize(message, response.message.id, true);
    return response;
  }

  async endTurn(
    toolResults: readonly ToolResultMessage[] = [],
    beforeEnd?: BeforeTurnEnd,
    replaceResult?: (before: ToolResultMessage, after: ToolResultMessage) => void,
  ): Promise<void> {
    if (!this.current) return;
    const results: ToolResult[] = [];
    const toolResultEntryIds: string[] = [];
    for (const native of toolResults) {
      const [message] = toPiMessages([native]);
      if (message?.role !== "toolResult") continue;
      this.emit({ type: "message_start", message });
      await this.flushExtensionEvents();
      const replacement = await this.getRunner()?.emitMessageEnd({ type: "message_end", message });
      const edited =
        replacement?.role === "toolResult"
          ? { ...replacement, content: replacement.content ?? [] }
          : undefined;
      if (edited) replaceResult?.(native, replacePiToolResult(native, message, edited));
      const final = edited ?? message;
      results.push(final);
      const entryId = this.project(final, native.id);
      if (entryId) toolResultEntryIds.push(entryId);
      this.emit({ type: "message_end", message: final }, true);
    }
    await this.flushExtensionEvents();
    if (this.messageEntryId) {
      await beforeEnd?.({
        turnIndex: this.turnIndex - 1,
        message: this.current,
        toolResults: results,
        messageEntryId: this.messageEntryId,
        toolResultEntryIds,
      });
    }
    this.emit({ type: "turn_end", message: this.current, toolResults: results });
    this.current = undefined;
  }

  async end(
    aborted: boolean,
    errorMessage?: string,
    beforeEnd?: BeforeTurnEnd,
    willRetry?: () => boolean,
  ): Promise<void> {
    if (this.current && !this.finalized) {
      this.finalize({ ...this.current, stopReason: aborted ? "aborted" : "error", errorMessage });
    }
    await this.endTurn([], beforeEnd);
    const messages = [...this.newMessages];
    await this.getRunner()?.emit({ type: "agent_end", messages });
    this.emit({ type: "agent_end", messages, willRetry: willRetry?.() ?? false });
  }

  async settle(aborted: boolean): Promise<void> {
    await this.flushExtensionEvents();
    await this.getRunner()?.emit({ type: "agent_settled", aborted });
    this.emit({ type: "agent_settled", aborted });
  }

  publishMessage(message: PiMessage, nativeId?: string): void {
    this.emit({ type: "message_start", message });
    this.project(message, nativeId);
    this.emit({ type: "message_end", message });
  }

  private startAssistant(assistant: PiAssistant): void {
    if (this.assistantStarted) return;
    this.assistantStarted = true;
    this.emit({ type: "message_start", message: { ...assistant, content: [] } });
  }

  private finalize(message: PiAssistant, nativeId?: string, messageEndHandled = false): void {
    const assistant = this.current!;
    this.startAssistant(assistant);
    this.closeText(assistant);
    this.current = message;
    this.finalized = true;
    this.messageEntryId = this.project(message, nativeId);
    this.emit({ type: "message_end", message }, messageEndHandled);
  }

  private textDelta(assistant: PiAssistant, kind: "thinking" | "text", delta: string): void {
    if (this.open?.kind !== kind) {
      this.closeText(assistant);
      const index = assistant.content.length;
      this.open = { kind, index };
      assistant.content.push(
        kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
      );
      this.delta(assistant, {
        type: kind === "text" ? "text_start" : "thinking_start",
        contentIndex: index,
        partial: assistant,
      });
    }
    const contentIndex = this.open!.index;
    const block = assistant.content[contentIndex];
    if (block?.type === "text") {
      block.text += delta;
      this.delta(assistant, { type: "text_delta", contentIndex, delta, partial: assistant });
    } else if (block?.type === "thinking") {
      block.thinking += delta;
      this.delta(assistant, { type: "thinking_delta", contentIndex, delta, partial: assistant });
    }
  }

  private closeText(assistant: PiAssistant): void {
    if (!this.open) return;
    const contentIndex = this.open.index;
    const block = assistant.content[contentIndex];
    if (block?.type === "text") {
      this.delta(assistant, {
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: assistant,
      });
    } else if (block?.type === "thinking") {
      this.delta(assistant, {
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: assistant,
      });
    }
    this.open = undefined;
  }

  private delta(assistant: PiAssistant, assistantMessageEvent: AssistantUpdate): void {
    this.emit({ type: "message_update", message: assistant, assistantMessageEvent });
  }
}
