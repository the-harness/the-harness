import { inject } from "@harness/di";
import { ServerTransport } from "@harness/transport";
import type { z } from "zod";
import type { StreamChannel, StreamContract, StreamEndpoints } from "./contract.ts";

export interface StreamContext {
  readonly scope: readonly string[];
  readonly signal?: AbortSignal;
}

export type StreamHandlers<T extends StreamEndpoints> = {
  readonly [K in keyof T]?: T[K] extends StreamChannel<infer I, infer C>
    ? (input: z.infer<I>, ctx: StreamContext) => AsyncIterable<z.infer<C>>
    : never;
};

export class StreamServerService {
  private readonly serverTransport = inject(ServerTransport);

  useHandlers<T extends StreamEndpoints>(
    contract: StreamContract<T>,
    handlers: StreamHandlers<T>,
  ): void {
    for (const [name] of Object.entries(contract.endpoints)) {
      const handler = handlers[name as keyof T];
      if (!handler) continue;
      const path = `/stream/${contract.namespace}.${name}`;
      this.serverTransport.useStream(path, (input, signal) =>
        (handler as any)(input, { scope: [], signal }),
      );
    }
  }
}
