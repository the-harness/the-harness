import { inject } from "@harness/di";
import { ServerTransport } from "@harness/transport";
import { deserializeValue, serializeValue } from "@harness/variants";
import type { z } from "zod";
import type { CallEndpoint, RpcContract, RpcEndpoints } from "./contract.ts";

export interface RpcContext {
  readonly scope: readonly string[];
  readonly signal?: AbortSignal;
}

export type RpcHandlers<T extends RpcEndpoints> = {
  readonly [K in keyof T]?: T[K] extends CallEndpoint<infer I, infer O>
    ? (input: z.infer<I>, ctx: RpcContext) => Promise<z.infer<O>> | z.infer<O>
    : never;
};

export class RpcServerService {
  private readonly serverTransport = inject(ServerTransport);

  useHandlers<T extends RpcEndpoints>(contract: RpcContract<T>, handlers: RpcHandlers<T>): void {
    for (const name of Object.keys(contract.endpoints)) {
      const handler = handlers[name as keyof T];
      if (!handler) continue;
      const route = `${contract.namespace}.${name}`;
      this.serverTransport.useCall(route, async (input, signal) =>
        serializeValue(await (handler as any)(deserializeValue(input), { scope: [], signal })),
      );
    }
  }
}
