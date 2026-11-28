import { inject } from "@harness/di";
import { StateSyncClientService } from "@harness/state-sync";
import { computed, type ComputedRef } from "reactivity";
import {
  InteractionStateSyncContract,
  type InteractionEntry,
} from "./variants.ts";

export * from "./variants.ts";

export class UiInteractionService {
  private readonly sync = inject(StateSyncClientService).use(
    InteractionStateSyncContract,
  );

  readonly active: ComputedRef<ReadonlyMap<string, readonly InteractionEntry[]>> =
    computed(() => {
      const map = new Map<string, readonly InteractionEntry[]>();
      for (const [sessionId, entries] of Object.entries(this.sync.active.value)) {
        if (entries.length > 0) map.set(sessionId, entries);
      }
      return map;
    });

  get(sessionId: string): readonly InteractionEntry[] {
    return this.active.value.get(sessionId) ?? [];
  }
}
