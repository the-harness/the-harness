// oxlint-disable-next-line harness/no-module-state -- per-instance storage; each instance only reaches the WeakMap of the module version that created it
const disposeCallbacks = new WeakMap<Disposable, () => unknown>();

export class Disposable {
  constructor(callOnDispose: () => unknown) {
    disposeCallbacks.set(this, callOnDispose);
  }

  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const disposable of disposables) disposable?.dispose();
    });
  }

  dispose(): void {
    const callback = disposeCallbacks.get(this);
    disposeCallbacks.delete(this);
    callback?.();
  }
}

export type Event<T> = (
  listener: (event: T) => unknown,
  thisArgs?: unknown,
  disposables?: Disposable[],
) => Disposable;

export class EventEmitter<T> {
  private readonly listeners = new Set<{ listener: (event: T) => unknown; thisArgs: unknown }>();
  private disposed = false;

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const entry = { listener, thisArgs };
    if (!this.disposed) this.listeners.add(entry);
    const disposable = new Disposable(() => this.listeners.delete(entry));
    disposables?.push(disposable);
    return disposable;
  };

  fire(event: T): void {
    for (const entry of [...this.listeners]) {
      if (!this.listeners.has(entry)) continue;
      try {
        entry.listener.call(entry.thisArgs, event);
      } catch (error) {
        console.error(error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<unknown>;
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<unknown>();
  private cancelled = false;
  readonly token: CancellationToken;

  constructor() {
    const source = this;
    this.token = {
      get isCancellationRequested() {
        return source.cancelled;
      },
      onCancellationRequested(listener, thisArgs, disposables) {
        if (!source.cancelled) return source.emitter.event(listener, thisArgs, disposables);
        const timeout = setTimeout(() => {
          try {
            listener.call(thisArgs, undefined);
          } catch (error) {
            console.error(error);
          }
        }, 0);
        const disposable = new Disposable(() => clearTimeout(timeout));
        disposables?.push(disposable);
        return disposable;
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emitter.fire(undefined);
    this.emitter.dispose();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}
