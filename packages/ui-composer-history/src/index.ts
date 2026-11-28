import { inject } from "@harness/di";
import { UiChatService } from "@harness/ui-chat";
import { watch } from "vue";
import { ComposerPromptHistory, type ComposerHistoryStep } from "./history.ts";

export class UiComposerHistoryService {
  readonly #chat = inject(UiChatService);
  readonly #history = new ComposerPromptHistory();

  constructor() {
    watch(this.#chat.draft, (text) => this.#history.observe(text), { flush: "sync" });
  }

  navigateOlder(caret: number): number | null {
    const text = this.#chat.draft.value;
    return this.#apply(
      this.#history.navigateOlder(text, caret, {
        messages: this.#chat.messages.value,
        pending: this.#chat.pendingInputs.value,
        queued: this.#chat.queuedInputs.value,
      }),
    );
  }

  navigateNewer(caret: number): number | null {
    return this.#apply(this.#history.navigateNewer(this.#chat.draft.value, caret));
  }

  #apply(step: ComposerHistoryStep | null): number | null {
    if (step === null) return null;
    if (step.text !== this.#chat.draft.value) this.#chat.draft.value = step.text;
    return step.caret;
  }
}
