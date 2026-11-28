import { onScopeDispose, ref, shallowRef, type Ref } from "vue";
import { createNotificationMenu } from "./menus.ts";

export type { NotificationMenuContext } from "./menus.ts";

export interface NotificationOptions {
  message: string;
  severity: "info" | "warning" | "error";
  actions: readonly string[];
  modal?: boolean;
  detail?: string;
  cancelAction?: number;
}

interface NotificationRequest extends NotificationOptions {
  readonly id: number;
  finish(selected?: number): void;
}

export class UiNotificationService {
  readonly menu = createNotificationMenu(this, () => this.disposed);
  readonly message: Ref<string> = ref("");
  readonly prompts = shallowRef<readonly NotificationRequest[]>([]);

  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextPromptId = 0;
  private disposed = false;

  constructor() {
    onScopeDispose(() => {
      this.disposed = true;
      this.clearTimer();
      for (const prompt of this.prompts.value) prompt.finish();
    });
  }

  notify(message: string, durationMs = 3500): void {
    this.message.value = message;
    this.clearTimer();
    if (durationMs > 0) {
      this.timer = setTimeout(() => {
        this.message.value = "";
        this.timer = undefined;
      }, durationMs);
    }
  }

  dismiss(): void {
    this.clearTimer();
    this.message.value = "";
  }

  showMessage(options: NotificationOptions, signal?: AbortSignal): Promise<number | undefined> {
    if (this.disposed || signal?.aborted) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      const id = ++this.nextPromptId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => finish();
      let finished = false;
      const finish = (selected?: number) => {
        if (finished) return;
        finished = true;
        this.prompts.value = this.prompts.value.filter((prompt) => prompt.id !== id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(selected);
      };

      signal?.addEventListener("abort", abort, { once: true });
      if (!options.modal && options.actions.length === 0) timer = setTimeout(finish, 3500);
      this.prompts.value = [...this.prompts.value, { ...options, id, finish }];
    });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

export { default as NotificationCenter } from "./components/NotificationCenter.vue";
