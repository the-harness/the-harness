export interface KeyedQueue {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, next);

      await prev;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === next) {
          tails.delete(key);
        }
      }
    },
  };
}

export type ArbiterResult<T> =
  | { readonly claimed: true; readonly result: T }
  | { readonly claimed: false };

export interface IdempotentArbiter {
  claim<T>(key: string, fn: () => Promise<T> | T): Promise<ArbiterResult<T>>;
  release(key: string): void;
}

export function createIdempotentArbiter(): IdempotentArbiter {
  const claimed = new Map<string, symbol>();

  return {
    async claim<T>(key: string, fn: () => Promise<T> | T): Promise<ArbiterResult<T>> {
      if (claimed.has(key)) {
        return { claimed: false };
      }
      const token = Symbol();
      claimed.set(key, token);
      try {
        const result = await fn();
        return { claimed: true, result };
      } catch (error) {
        if (claimed.get(key) === token) claimed.delete(key);
        throw error;
      }
    },
    release(key: string): void {
      claimed.delete(key);
    },
  };
}
