import { inject } from "@harness/di";
import { Transport } from "@harness/transport";
import { deserializeValue, serializeValue } from "@harness/variants";
import { effectScope, getCurrentScope, onScopeDispose, type EffectScope } from "reactivity";
import type { StreamClient, StreamContract, StreamEndpoints } from "./contract.ts";

interface ClientEntry {
  readonly client: unknown;
  readonly scope: EffectScope;
  refs: number;
}

export class StreamClientService {
  private readonly transport = inject(Transport);
  private readonly entries = new Map<StreamContract<any>, ClientEntry>();
  private readonly scope = effectScope();

  constructor() {
    onScopeDispose(() => this.entries.clear());
  }

  use<T extends StreamEndpoints>(contract: StreamContract<T>): StreamClient<T> {
    if (!this.scope.active) throw new Error("StreamClientService is disposed");
    if (!getCurrentScope()?.active) {
      throw new Error("use() requires an active EffectScope");
    }
    const entry = this.entries.get(contract) ?? this.createEntry(contract);
    entry.refs += 1;
    onScopeDispose(() => {
      entry.refs -= 1;
      if (entry.refs === 0) {
        this.entries.delete(contract);
        entry.scope.stop();
      }
    });
    return entry.client as StreamClient<T>;
  }

  private createEntry(contract: StreamContract): ClientEntry {
    const scope = this.scope.run(() => effectScope())!;
    const lifetime = new AbortController();
    scope.run(() => onScopeDispose(() => lifetime.abort()));
    const transport = this.transport;
    const client: Record<string, unknown> = {};
    for (const [name, endpoint] of Object.entries(contract.endpoints)) {
      const path = `/stream/${contract.namespace}.${name}`;
      client[name] = async function* (input: unknown, signal?: AbortSignal) {
        const parsedInput = endpoint.input.parse(input);
        const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
        for await (const chunk of transport.openStream(
          path,
          serializeValue(parsedInput),
          combined,
        )) {
          yield endpoint.chunk.parse(deserializeValue(chunk));
        }
      };
    }
    const entry: ClientEntry = { client, scope, refs: 0 };
    this.entries.set(contract, entry);
    return entry;
  }
}
