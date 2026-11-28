import { createDescriptor, type Descriptor } from "@harness/di";
import { getCurrentScope, onScopeDispose } from "reactivity";

export type CallHandler = (body: unknown, signal: AbortSignal) => Promise<unknown> | unknown;
export type StreamHandler = (body: unknown, signal: AbortSignal) => AsyncIterable<unknown>;

// Child transports by id, kept outside the class so a child can register with its parent.
const childrenOf = new WeakMap<ServerTransport, Map<string, ServerTransport>>();

export class ServerTransport {
  private readonly callHandlers = new Map<string, CallHandler>();
  private readonly streamHandlers = new Map<string, StreamHandler>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly onDisposeCallback: ((self: ServerTransport) => void) | undefined;
  private disposed = false;

  constructor(onDisposeCallback?: (self: ServerTransport) => void) {
    this.onDisposeCallback = onDisposeCallback;
    childrenOf.set(this, new Map());
    if (getCurrentScope()) {
      onScopeDispose(() => this.dispose());
    }
  }

  private get children(): Map<string, ServerTransport> {
    return childrenOf.get(this)!;
  }

  useCall(path: string, handler: CallHandler): void {
    this.callHandlers.set(path, handler);
    if (getCurrentScope()) {
      onScopeDispose(() => {
        if (this.callHandlers.get(path) === handler) {
          this.callHandlers.delete(path);
        }
      });
    }
  }

  useStream(path: string, handler: StreamHandler): void {
    this.streamHandlers.set(path, handler);
    if (getCurrentScope()) {
      onScopeDispose(() => {
        if (this.streamHandlers.get(path) === handler) {
          this.streamHandlers.delete(path);
        }
      });
    }
  }

  childScope(id: string): Descriptor<ServerTransport> {
    return createDescriptor(ChildServerTransport, this, id);
  }

  protected resolveScope(scope: readonly string[]): ServerTransport {
    let current: ServerTransport = this;
    for (const segment of scope) {
      const next = current.children.get(segment);
      if (!next || next.disposed) {
        throw new Error(`Scope not found: ${scope.join("/")}`);
      }
      current = next;
    }
    return current;
  }

  protected async dispatchCall(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const handler = this.callHandlers.get(path);
    if (!handler) {
      throw new Error(`Unknown call path: ${path}`);
    }
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal.aborted) {
      ac.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    this.activeControllers.add(ac);
    try {
      return await handler(body, ac.signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.activeControllers.delete(ac);
    }
  }

  protected async *dispatchStream(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    const handler = this.streamHandlers.get(path);
    if (!handler) {
      throw new Error(`Unknown stream path: ${path}`);
    }
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal.aborted) {
      ac.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    this.activeControllers.add(ac);
    try {
      yield* handler(body, ac.signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.activeControllers.delete(ac);
    }
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ac of this.activeControllers) {
      ac.abort(new Error("ServerTransport scope disposed"));
    }
    this.activeControllers.clear();
    this.callHandlers.clear();
    this.streamHandlers.clear();
    for (const child of this.children.values()) {
      child.dispose();
    }
    this.children.clear();
    this.onDisposeCallback?.(this);
  }
}

// A class rather than a factory, so DI accepts it as a ServerTransport implementation.
class ChildServerTransport extends ServerTransport {
  constructor(parent: ServerTransport, id: string) {
    super((self) => {
      const siblings = childrenOf.get(parent);
      if (siblings?.get(id) === self) siblings.delete(id);
    });
    childrenOf.get(parent)!.set(id, this);
  }
}

export class RootServerTransport extends ServerTransport {
  handleCall(
    scope: readonly string[],
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.resolveScope(scope).dispatchCall(path, body, signal);
  }

  handleStream(
    scope: readonly string[],
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    return this.resolveScope(scope).dispatchStream(path, body, signal);
  }
}
