import { inject } from "@harness/di";
import { Transport } from "@harness/transport";
import { effectScope, getCurrentScope, onScopeDispose, type EffectScope } from "reactivity";
import type { StateSyncClient, StateSyncContract, StateSyncEndpoints } from "./contract.ts";

interface ClientEntry {
  readonly client: unknown;
  readonly scope: EffectScope;
  refs: number;
}

export class StateSyncClientService {
  private readonly transport = inject(Transport);
  private readonly entries = new Map<StateSyncContract<any>, ClientEntry>();
  private readonly scope = effectScope();

  use<T extends StateSyncEndpoints>(contract: StateSyncContract<T>): StateSyncClient<T> {
    if (getCurrentScope() === undefined) {
      throw new Error("use() requires an active EffectScope");
    }
    const entry = this.entries.get(contract) ?? this.createEntry(contract);
    entry.refs += 1;
    onScopeDispose(() => {
      entry.refs -= 1;
      if (entry.refs === 0) {
        entry.scope.stop();
        this.entries.delete(contract);
      }
    });
    return entry.client as StateSyncClient<T>;
  }

  private createEntry(contract: StateSyncContract): ClientEntry {
    const scope = this.scope.run(() => effectScope())!;
    const client: Record<string, unknown> = {};
    scope.run(() => {
      for (const [name, endpoint] of Object.entries(contract.endpoints)) {
        client[name] = endpoint.createClient(this.transport, {
          rpcPath: `/rpc/state-sync:${contract.namespace}.${name}`,
          streamPath: `/stream/state-sync:${contract.namespace}.${name}`,
        });
      }
    });
    const entry: ClientEntry = { client, scope, refs: 0 };
    this.entries.set(contract, entry);
    return entry;
  }
}
