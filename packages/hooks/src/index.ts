import { onScopeDispose, shallowReactive } from "reactivity";

declare const hookAnchorBrand: unique symbol;

export interface HookAnchor {
  readonly [hookAnchorBrand]: true;
}

export type HookNext<TInput, TResult> = (input?: TInput) => TResult;

export type HookHandler<TInput, TResult = void> = (
  input: TInput,
  next: HookNext<TInput, TResult>,
) => TResult;

export interface HookPosition {
  before?: HookAnchor;
  after?: HookAnchor;
}

export type HookTerminal<TInput, TResult> = (input: TInput) => TResult;

interface HookEntry<TInput, TResult> {
  readonly anchor: HookAnchor;
  readonly handler: HookHandler<TInput, TResult>;
}

export class HookSlot<TInput, TResult = void> {
  protected readonly entries = shallowReactive<HookEntry<TInput, TResult>[]>([]);

  use(handler: HookHandler<TInput, TResult>, position: HookPosition = {}): HookAnchor {
    if (position.before !== undefined && position.after !== undefined) {
      throw new Error("Hook registration cannot specify both before and after");
    }

    const anchor = Object.freeze({}) as HookAnchor;
    const entry: HookEntry<TInput, TResult> = { anchor, handler };
    const target = position.before ?? position.after;

    if (target === undefined) {
      this.entries.push(entry);
    } else {
      const targetIndex = this.entries.findIndex((item) => item.anchor === target);
      if (targetIndex < 0) {
        throw new Error("Hook anchor target is not registered in this slot");
      }
      const insertAt = position.before !== undefined ? targetIndex : targetIndex + 1;
      this.entries.splice(insertAt, 0, entry);
    }

    onScopeDispose(() => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) {
        this.entries.splice(index, 1);
      }
    });

    return anchor;
  }

  run(
    input: TInput,
    ...args: [TResult] extends [void]
      ? [terminal?: HookTerminal<TInput, TResult>]
      : [terminal: HookTerminal<TInput, TResult>]
  ): TResult {
    const [terminal] = args;
    const snapshot = [...this.entries];

    const dispatch = (index: number, current: TInput): HookNext<TInput, TResult> => {
      return (override?: TInput): TResult => {
        const nextInput = override !== undefined ? override : current;
        const entry = snapshot[index];
        if (entry === undefined) {
          if (terminal === undefined) {
            return undefined as TResult;
          }
          return terminal(nextInput);
        }
        return entry.handler(nextInput, dispatch(index + 1, nextInput));
      };
    };

    return dispatch(0, input)();
  }
}
