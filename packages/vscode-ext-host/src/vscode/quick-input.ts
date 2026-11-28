import { InputBoxValidationSeverity, type CancellationToken } from "@harness/vscode-types";
import type { InputBoxOptions, QuickPickItem, QuickPickOptions } from "@harness/ui-quick-input";
import type { ExtHostBridge } from "./bridge.ts";

type PickItem = string | QuickPickItem;
type PickItems<T> = readonly T[] | PromiseLike<readonly T[]>;
type PickOptions = QuickPickOptions & { canPickMany?: boolean };
type Validation =
  | string
  | { message: string; severity: InputBoxValidationSeverity }
  | null
  | undefined;

export type ShowQuickPick = ReturnType<typeof createQuickInputApi>["showQuickPick"];

type WindowInputOptions = Omit<InputBoxOptions, "validateInput" | "validateOnChange"> & {
  validateInput?: (value: string) => Validation | PromiseLike<Validation>;
};

export function createQuickInputApi(bridge: ExtHostBridge) {
  async function withCancellation<T>(
    run: (id: string) => Promise<T | undefined>,
    token?: CancellationToken,
  ): Promise<T | undefined> {
    if (token?.isCancellationRequested) return undefined;
    const id = crypto.randomUUID();
    if (!token) return run(id);
    const canceled = Promise.withResolvers<undefined>();
    const subscription = token.onCancellationRequested(() => {
      void bridge.callMain("window.cancelQuickInput", id).catch(() => undefined);
      canceled.resolve(undefined);
    });
    try {
      return await Promise.race([run(id), canceled.promise]);
    } finally {
      subscription.dispose();
    }
  }

  function showQuickPick<T extends PickItem>(
    items: PickItems<T>,
    options: PickOptions & { canPickMany: true },
    token?: CancellationToken,
  ): Promise<T[] | undefined>;
  function showQuickPick<T extends PickItem>(
    items: PickItems<T>,
    options?: PickOptions,
    token?: CancellationToken,
  ): Promise<T | undefined>;
  function showQuickPick<T extends PickItem>(
    items: PickItems<T>,
    options?: PickOptions,
    token?: CancellationToken,
  ): Promise<T | T[] | undefined> {
    return withCancellation(async (id) => {
      const available = await items;
      if (token?.isCancellationRequested) return undefined;
      const displayItems = available.map((item) =>
        typeof item === "string"
          ? { label: item }
          : {
              label: item.label,
              description: item.description,
              detail: item.detail,
              picked: item.picked,
            },
      );
      const picked = (await bridge.callMain("window.showQuickPick", id, displayItems, options)) as
        | number
        | number[]
        | undefined;
      if (picked === undefined) return undefined;
      if (Array.isArray(picked)) return picked.map((index) => available[index]!);
      return available[picked];
    }, token);
  }

  function showInputBox(options: WindowInputOptions = {}, token?: CancellationToken) {
    const { validateInput, ...displayOptions } = options;
    let validationCommand: string | undefined;
    return withCancellation<string>(async (id) => {
      if (validateInput) {
        validationCommand = `__win.validateInput.${id}`;
        bridge.commandHandlers.set(validationCommand, async (value) => {
          const result = await validateInput(String(value));
          if (typeof result === "string") return result;
          if (!result) return undefined;
          const severity =
            result.severity === InputBoxValidationSeverity.Error
              ? "error"
              : result.severity === InputBoxValidationSeverity.Warning
                ? "warning"
                : "info";
          return { message: result.message, severity };
        });
      }
      return (await bridge.callMain("window.showInputBox", id, displayOptions, !!validateInput)) as
        | string
        | undefined;
    }, token).finally(() => {
      if (validationCommand) bridge.commandHandlers.delete(validationCommand);
    });
  }

  return { showQuickPick, showInputBox };
}
