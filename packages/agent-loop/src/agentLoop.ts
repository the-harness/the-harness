import { Context, type ContextBatch } from "@harness/context";
import { inject } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import {
  AssistantMessage,
  LlmService,
  mergeStreamChunk,
  Message,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
} from "@harness/llm";
import { variant } from "@harness/variants";
import { ModelSelectionService } from "@harness/model-selection";
import { onScopeDispose, shallowRef } from "reactivity";
import {
  SupplementaryField,
  type AgentLoopHooks,
  type AgentLoopOptions,
  type ContextTransformInput,
  type HandleOutputInput,
  type LlmInputPayload,
  type LoopStopReason,
} from "./types.ts";

export interface ActiveRun {
  readonly controller: AbortController;
  readonly promise: Promise<LoopStopReason>;
}

export type RunStopReason = "completed" | "max_tokens" | "aborted" | "error";

@variant("core:agent-loop:run-stop")
export class RunStopMessage extends Message {
  declare readonly stopReason: RunStopReason;
  declare readonly message?: string;
}

export class AgentLoop {
  readonly hooks: AgentLoopHooks = {
    shouldSend: new HookSlot<void, boolean>(),
    transformContext: new HookSlot<ContextTransformInput, Promise<LlmInputPayload>>(),
    streamChunk: new HookSlot<LlmStreamChunk, void>(),
    handleOutput: new HookSlot<HandleOutputInput, Promise<void>>(),
    handleError: new HookSlot<unknown, Promise<void>>(),
  };

  options: AgentLoopOptions;

  protected readonly context = inject(Context);
  protected readonly llm = inject(LlmService);
  protected readonly modelSelection = inject(ModelSelectionService);
  protected readonly activeRun = shallowRef<ActiveRun | undefined>();

  constructor(options: AgentLoopOptions = {}) {
    this.options = options;
    onScopeDispose(() => {
      this.activeRun.value?.controller.abort();
    });
  }

  get isRunning(): boolean {
    return this.activeRun.value !== undefined;
  }

  shouldSend(): boolean {
    return this.hooks.shouldSend.run(undefined, () => {
      const nonSupplementary = this.context.pending.filter(
        (item) => item.meta.get(SupplementaryField) !== true,
      );
      return this.llm.canSend(nonSupplementary);
    });
  }

  abort(): void {
    this.activeRun.value?.controller.abort();
  }

  run(): Promise<LoopStopReason> {
    if (this.activeRun.value !== undefined) {
      throw new Error(`loop is already running for context '${this.context.id}'`);
    }
    const controller = new AbortController();
    let active = true;
    const promise = this.executeLoop(controller.signal, () => {
      active = false;
      if (this.activeRun.value?.controller === controller) {
        this.activeRun.value = undefined;
      }
    });
    if (active) {
      this.activeRun.value = { controller, promise };
    }
    return promise;
  }

  protected async defaultTransformContext(input: ContextTransformInput): Promise<LlmInputPayload> {
    const minIndex = input.stopBeforeIndex ?? 0;
    const batches: ContextBatch[] = [];
    for await (const batch of this.context.readBackward()) {
      if (batch.index < minIndex) {
        break;
      }
      batches.push(batch);
    }
    batches.reverse();

    return { messages: batches.flatMap((batch) => batch.messages) };
  }

  protected async executeLoop(signal: AbortSignal, cleanup: () => void): Promise<LoopStopReason> {
    let step = 0;
    const maxSteps = this.options.maxSteps ?? Infinity;
    const { maxSteps: _maxSteps, ...requestOptions } = this.options;

    try {
      while (this.shouldSend()) {
        if (signal.aborted) {
          return "aborted";
        }
        if (step >= maxSteps) {
          return "max_steps";
        }
        step += 1;

        this.context.batch();
        if (signal.aborted) {
          this.context.unbatch();
          return "aborted";
        }

        let response: LlmResponse | undefined;
        let streamingMessage: AssistantMessage | undefined;
        try {
          const payload = await this.hooks.transformContext.run({}, (input) =>
            this.defaultTransformContext(input),
          );
          if (signal.aborted) {
            this.context.unbatch();
            return "aborted";
          }

          const { provider, model, reasoning, temperature, maxTokens } =
            this.modelSelection.current;
          const request: LlmRequest = {
            ...requestOptions,
            provider,
            model,
            reasoning,
            temperature,
            maxTokens,
            systemPrompt: payload.systemPrompt,
            tools: payload.tools,
            messages: payload.messages,
            signal,
          };

          signal.throwIfAborted();
          const stream = this.llm.stream(request);
          for await (const chunk of stream) {
            if (signal.aborted) break;
            this.hooks.streamChunk.run(chunk, (finalChunk) => {
              const next = mergeStreamChunk(streamingMessage, finalChunk);
              if (next && next !== streamingMessage) {
                const idx = streamingMessage ? this.context.pending.indexOf(streamingMessage) : -1;
                streamingMessage = next;
                if (idx !== -1) {
                  this.context.pending[idx] = streamingMessage;
                } else {
                  this.context.pending.push(streamingMessage);
                }
              }
            });
          }
          response = signal.aborted ? undefined : await stream.result();
          if (response?.stopReason === "error") {
            throw new Error(response.error?.message ?? "LLM request failed");
          }
        } catch (error) {
          if (streamingMessage !== undefined) {
            const idx = this.context.pending.indexOf(streamingMessage);
            if (idx !== -1) {
              this.context.pending.splice(idx, 1);
            }
          }
          this.context.unbatch();
          if (signal.aborted) {
            return "aborted";
          }
          await this.hooks.handleError.run(error, async (unhandled) => {
            throw unhandled;
          });
          step -= 1;
          continue;
        }

        if (response === undefined || response.stopReason === "aborted" || signal.aborted) {
          if (streamingMessage !== undefined) {
            const idx = this.context.pending.indexOf(streamingMessage);
            if (idx !== -1) {
              this.context.pending.splice(idx, 1);
            }
          }
          this.context.unbatch();
          this.recordStop("aborted");
          return "aborted";
        }
        if (response.stopReason === "max_tokens") {
          if (streamingMessage !== undefined) {
            const idx = this.context.pending.indexOf(streamingMessage);
            if (idx !== -1) {
              this.context.pending.splice(idx, 1);
            }
          }
          this.context.unbatch();
          this.recordStop("max_tokens");
          return "max_tokens";
        }

        const idx = streamingMessage ? this.context.pending.indexOf(streamingMessage) : -1;
        if (idx !== -1) {
          this.context.pending[idx] = response.message;
        } else {
          this.context.pending.push(response.message);
        }

        await this.hooks.handleOutput.run({ response, signal }, () => Promise.resolve());

        if (signal.aborted) {
          this.recordStop("aborted");
          return "aborted";
        }
      }
      this.recordStop("completed");
      return "completed";
    } catch (caught) {
      if (signal.aborted) {
        this.recordStop("aborted");
        return "aborted";
      }
      this.recordStop("error", caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      cleanup();
    }
  }

  private recordStop(stopReason: RunStopReason, message?: string): void {
    const entry = RunStopMessage.create({
      stopReason,
      ...(message !== undefined ? { message } : {}),
    });
    entry.meta.set(SupplementaryField, true);
    this.context.pending.push(entry);
  }
}
