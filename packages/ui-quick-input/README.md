```ts
interface QuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly picked?: boolean;
}

interface QuickPickOptions {
  readonly title?: string;
  readonly placeHolder?: string;
  readonly matchOnDescription?: boolean;
  readonly matchOnDetail?: boolean;
}

type InputValidation =
  | string
  | { message: string; severity: "info" | "warning" | "error" }
  | undefined;

interface InputBoxOptions {
  readonly title?: string;
  readonly prompt?: string;
  readonly placeHolder?: string;
  readonly value?: string;
  readonly password?: boolean;
  readonly validateInput?: (value: string) => InputValidation | PromiseLike<InputValidation>;
  readonly validateOnChange?: boolean;
}

class UiQuickInputService {
  readonly activeRequest: ComputedRef<QuickInputRequest | null>; // 当前请求的只读响应式视图
  showQuickPick<T extends QuickPickItem>(
    items: readonly T[],
    options?: QuickPickOptions,
  ): Promise<T | undefined>;
  showQuickPickMany<T extends QuickPickItem>(
    items: readonly T[],
    options?: QuickPickOptions,
  ): Promise<T[] | undefined>;
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>;
  resolveActive(value: unknown): void;
  cancelActive(): void;
}
```
