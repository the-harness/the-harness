import type { z } from "zod";

export interface StreamChannel<I extends z.ZodTypeAny, C extends z.ZodTypeAny> {
  readonly input: I;
  readonly chunk: C;
}

export type StreamEndpoints = Record<string, StreamChannel<z.ZodTypeAny, z.ZodTypeAny>>;

export interface StreamContract<T extends StreamEndpoints = StreamEndpoints> {
  readonly namespace: string;
  readonly endpoints: T;
}

export type StreamClient<T extends StreamEndpoints> = {
  readonly [K in keyof T]: T[K] extends StreamChannel<infer I, infer C>
    ? z.infer<I> extends void
      ? (input?: void, signal?: AbortSignal) => AsyncIterable<z.infer<C>>
      : (input: z.infer<I>, signal?: AbortSignal) => AsyncIterable<z.infer<C>>
    : never;
};

export const stream = {
  channel<I extends z.ZodTypeAny, C extends z.ZodTypeAny>(input: I, chunk: C): StreamChannel<I, C> {
    return { input, chunk };
  },
};

export function defineStreamContract<T extends StreamEndpoints>(
  namespace: string,
  endpoints: T,
): StreamContract<T> {
  return { namespace, endpoints };
}
