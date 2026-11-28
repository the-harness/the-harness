import { extractText, type UserMessage } from "@harness/llm";
import type { SessionMessage } from "@harness/ui-chat";

const COMPOSER_HISTORY_LIMIT = 100;

export interface ComposerHistoryStep {
  readonly text: string;
  readonly caret: number;
}

export interface ComposerPromptSource {
  readonly messages: readonly SessionMessage[];
  readonly pending: readonly UserMessage[];
  readonly queued: readonly UserMessage[];
}

function collectPrompts(source: ComposerPromptSource): string[] {
  const prompts: string[] = [];
  const push = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0 || prompts.at(-1) === text) return;
    prompts.push(text);
  };
  for (const message of source.messages) {
    if (message.role === "user") push(message.text);
  }
  for (const message of source.pending) push(extractText(message.content));
  for (const message of source.queued) push(extractText(message.content));
  return prompts.slice(-COMPOSER_HISTORY_LIMIT);
}

export class ComposerPromptHistory {
  #prompts: readonly string[] = [];
  #index = -1;
  #saved: ComposerHistoryStep | null = null;

  navigateOlder(
    text: string,
    caret: number,
    source: ComposerPromptSource,
  ): ComposerHistoryStep | null {
    if (text.slice(0, caret).includes("\n")) return null;
    if (this.#index < 0) {
      if (caret > 0) return { text, caret: 0 };
      const prompts = collectPrompts(source);
      if (prompts.length === 0) return null;
      this.#prompts = prompts;
      this.#saved = { text, caret };
      this.#index = prompts.length - 1;
      return { text: prompts[this.#index]!, caret: 0 };
    }
    if (this.#index === 0) return { text, caret };
    this.#index -= 1;
    return { text: this.#prompts[this.#index]!, caret: 0 };
  }

  navigateNewer(text: string, caret: number): ComposerHistoryStep | null {
    if (text.slice(caret).includes("\n")) return null;
    if (this.#index < 0) return null;
    if (this.#index < this.#prompts.length - 1) {
      this.#index += 1;
      const next = this.#prompts[this.#index]!;
      return { text: next, caret: next.length };
    }
    const saved = this.#saved;
    this.#reset();
    return saved ?? { text, caret };
  }

  observe(text: string): void {
    if (this.#index < 0) return;
    if (text !== this.#prompts[this.#index]) this.#reset();
  }

  #reset(): void {
    this.#prompts = [];
    this.#index = -1;
    this.#saved = null;
  }
}
