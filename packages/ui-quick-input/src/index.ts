import { computed, onScopeDispose, shallowRef, type ComputedRef } from "vue";

export interface QuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly picked?: boolean;
}

export interface QuickPickOptions {
  readonly title?: string;
  readonly placeHolder?: string;
  readonly matchOnDescription?: boolean;
  readonly matchOnDetail?: boolean;
}

export interface InputBoxOptions {
  readonly title?: string;
  readonly prompt?: string;
  readonly placeHolder?: string;
  readonly value?: string;
  readonly password?: boolean;
  readonly validateInput?: (value: string) => InputValidation | PromiseLike<InputValidation>;
  readonly validateOnChange?: boolean;
}

export type InputValidation =
  | string
  | { message: string; severity: "info" | "warning" | "error" }
  | undefined;

export type QuickInputRequest =
  | {
      readonly kind: "pick";
      readonly items: readonly QuickPickItem[];
      readonly options?: QuickPickOptions;
      readonly multiple?: boolean;
    }
  | {
      readonly kind: "input";
      readonly options?: InputBoxOptions;
    };

interface ActiveInput {
  readonly request: QuickInputRequest;
  resolve(value: unknown): void;
}

export class UiQuickInputService {
  private readonly active = shallowRef<ActiveInput>();
  private disposed = false;
  readonly activeRequest: ComputedRef<QuickInputRequest | null> = computed(
    () => this.active.value?.request ?? null,
  );

  constructor() {
    onScopeDispose(() => {
      this.disposed = true;
      this.cancelActive();
    });
  }

  showQuickPick<T extends QuickPickItem>(
    items: readonly T[],
    options?: QuickPickOptions,
  ): Promise<T | undefined> {
    return this.show<T>({ kind: "pick", items, options });
  }

  showQuickPickMany<T extends QuickPickItem>(
    items: readonly T[],
    options?: QuickPickOptions,
  ): Promise<T[] | undefined> {
    return this.show<T[]>({ kind: "pick", items, options, multiple: true });
  }

  showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    return this.show<string>({ kind: "input", options });
  }

  resolveActive(value: unknown): void {
    const current = this.active.value;
    try {
      this.active.value = undefined;
    } finally {
      current?.resolve(value);
    }
  }

  cancelActive(): void {
    this.resolveActive(undefined);
  }

  private show<T>(request: QuickInputRequest): Promise<T | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.active.value?.resolve(undefined);
      this.active.value = {
        request,
        resolve: (value) => resolve(value as T | undefined),
      };
    });
  }
}

export { default as QuickInputModal } from "./components/QuickInputModal.vue";
