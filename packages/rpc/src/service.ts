import { inject } from "@harness/di";
import { Transport } from "@harness/transport";
import { deserializeValue, serializeValue } from "@harness/variants";
import { effectScope, getCurrentScope, onScopeDispose, type EffectScope } from "reactivity";
import type { RpcClient, RpcContract, RpcEndpoints } from "./contract.ts";

interface ClientEntry {
  readonly client: unknown;
  readonly scope: EffectScope;
  refs: number;
}

export class RpcClientService {
  private readonly transport = inject(Transport);
  private readonly entries = new Map<RpcContract<any>, ClientEntry>();
  private readonly scope = effectScope();

  constructor() {
    onScopeDispose(() => this.entries.clear());
  }

  use<T extends RpcEndpoints>(contract: RpcContract<T>): RpcClient<T> {
    if (!this.scope.active) throw new Error("RpcClientService is disposed");
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
    return entry.client as RpcClient<T>;
  }

  private createEntry(contract: RpcContract): ClientEntry {
    const scope = this.scope.run(() => effectScope())!;
    const lifetime = new AbortController();
    scope.run(() => onScopeDispose(() => lifetime.abort()));
    const client: Record<string, unknown> = {};
    for (const [name, endpoint] of Object.entries(contract.endpoints)) {
      const path = `/rpc/${contract.namespace}.${name}`;
      client[name] = async (input: unknown, signal?: AbortSignal) => {
        const parsedInput = endpoint.input.parse(input);
        const result = await this.transport.request(
          path,
          serializeValue(parsedInput),
          signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
        );
        return endpoint.output.parse(deserializeValue(result));
      };
    }
    const entry: ClientEntry = { client, scope, refs: 0 };
    this.entries.set(contract, entry);
    return entry;
  }
}
