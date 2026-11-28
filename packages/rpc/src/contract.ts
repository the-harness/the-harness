import type { z } from "zod";

export interface CallEndpoint<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  readonly kind: "call";
  readonly input: I;
  readonly output: O;
}

export type RpcEndpoint = CallEndpoint<z.ZodTypeAny, z.ZodTypeAny>;

export type RpcEndpoints = Record<string, RpcEndpoint>;

export interface RpcContract<T extends RpcEndpoints = RpcEndpoints> {
  readonly namespace: string;
  readonly endpoints: T;
}

export type RpcClient<T extends RpcEndpoints> = {
  readonly [K in keyof T]: T[K] extends CallEndpoint<infer I, infer O>
    ? z.infer<I> extends void
      ? (input?: void, signal?: AbortSignal) => Promise<z.infer<O>>
      : (input: z.infer<I>, signal?: AbortSignal) => Promise<z.infer<O>>
    : never;
};

export const rpc = {
  call<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(input: I, output: O): CallEndpoint<I, O> {
    return { kind: "call", input, output };
  },
};

export function defineRpcContract<T extends RpcEndpoints>(
  namespace: string,
  endpoints: T,
): RpcContract<T> {
  return { namespace, endpoints };
}
