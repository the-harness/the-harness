import { createDescriptor } from "@harness/di";

interface ActiveRun<TEvent> {
  readonly controller: AbortController;
  readonly events: TEvent[];
  readonly waiters: Set<() => void>;
  done: boolean;
}

export class ChatRunService<TEvent = unknown> {
  static readonly [Symbol.for("harness.di.descriptor")] = createDescriptor(
    () => new ChatRunService(),
  );

  private activeRun: ActiveRun<TEvent> | undefined;

  get isRunning(): boolean {
    return this.activeRun !== undefined && !this.activeRun.done;
  }

  start(run: (emit: (event: TEvent) => void, signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    const active: ActiveRun<TEvent> = {
      controller,
      events: [],
      waiters: new Set(),
      done: false,
    };
    this.activeRun = active;

    const notify = () => {
      for (const wake of active.waiters) {
        wake();
      }
      active.waiters.clear();
    };

    void run((event) => {
      active.events.push(event);
      notify();
    }, controller.signal).finally(() => {
      active.done = true;
      notify();
      if (this.activeRun === active) {
        this.activeRun = undefined;
      }
    });
  }

  subscribe(signal?: AbortSignal): AsyncIterable<TEvent> | null {
    const active = this.activeRun;
    if (!active || active.done) {
      return null;
    }

    return {
      async *[Symbol.asyncIterator]() {
        let cursor = 0;
        while (true) {
          while (cursor < active.events.length && !signal?.aborted) {
            yield active.events[cursor++]!;
          }
          if (active.done || signal?.aborted) {
            return;
          }
          await new Promise<void>((resolve) => {
            const wake = () => {
              signal?.removeEventListener("abort", wake);
              active.waiters.delete(wake);
              resolve();
            };
            active.waiters.add(wake);
            signal?.addEventListener("abort", wake, { once: true });
          });
        }
      },
    };
  }

  abort(): boolean {
    const active = this.activeRun;
    if (!active || active.done) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  dispose(): void {
    this.abort();
  }
}
