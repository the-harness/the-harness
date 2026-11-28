import { AgentLoop, RunStopMessage } from "@harness/agent-loop";
import { Context } from "@harness/context";
import { inject } from "@harness/di";
import type { HookSlot } from "@harness/hooks";
import { SessionInteractionService } from "@harness/user-interaction/node";
import { SessionDigestService, SessionDigestStore } from "@harness/session-digest/node";
import { StateSyncServerService, SyncedRecordHost } from "@harness/state-sync";
import { computed, onScopeDispose, watchSyncEffect, type ComputedRef } from "reactivity";
import {
  CompletedSessionStatus,
  FailedSessionStatus,
  RunningSessionStatus,
  SessionStatus,
  SessionStatusStateSyncContract,
  WaitingForUserSessionStatus,
  sessionStatusField,
} from "./variants.ts";

export interface SessionStatusHooks {
  readonly status: HookSlot<void, SessionStatus | undefined>;
}

export class SessionStatusService {
  private readonly digest = inject(SessionDigestService);
  private readonly agentLoop = inject(AgentLoop);
  private readonly context = inject(Context);
  private readonly interaction = inject(SessionInteractionService, { optional: true });

  readonly hooks: SessionStatusHooks = {
    status: this.digest.hook(sessionStatusField),
  };

  readonly current: ComputedRef<SessionStatus | undefined> = computed(() =>
    this.digest.get(sessionStatusField),
  );

  constructor() {
    // FIXME: 当前仅靠 agentLoop.isRunning 与 context.pending 末尾的 RunStopMessage 判断状态很不可靠
    this.hooks.status.use((_, next) => {
      if (this.interaction && this.interaction.pending.value.length > 0) {
        return WaitingForUserSessionStatus.create();
      }
      if (this.agentLoop.isRunning) {
        return RunningSessionStatus.create();
      }
      for (let i = this.context.pending.length - 1; i >= 0; i--) {
        const msg = this.context.pending[i];
        if (msg instanceof RunStopMessage) {
          if (msg.stopReason === "error") {
            return FailedSessionStatus.create({ message: msg.message });
          }
          if (msg.stopReason === "aborted") {
            return undefined;
          }
          return CompletedSessionStatus.create();
        }
      }
      return next();
    });
  }

  set(status: SessionStatus | undefined): void {
    if (status === undefined) {
      this.digest.delete(sessionStatusField);
    } else {
      this.digest.set(sessionStatusField, status);
    }
  }
}

export function recoverSessionStatuses(): void {
  const store = inject(SessionDigestStore);
  for (const digest of store.digests.values()) {
    const current = digest.get(sessionStatusField);
    if (current === undefined) continue;
    const recovered = current.recover();
    if (recovered === undefined) {
      digest.delete(sessionStatusField);
    } else if (recovered !== current) {
      digest.set(sessionStatusField, recovered);
    }
  }
}

export class SessionStatusHostService {
  private readonly store = inject(SessionDigestStore);

  readonly active = new SyncedRecordHost<SessionStatus>();

  constructor() {
    const stop = watchSyncEffect(() => {
      const seen = new Set<string>();
      for (const [sessionId, digest] of this.store.digests) {
        const status = digest.get(sessionStatusField);
        if (status !== undefined) {
          seen.add(sessionId);
          this.active.items.set(sessionId, status);
        } else {
          this.active.items.delete(sessionId);
        }
      }
      for (const sessionId of Array.from(this.active.items.keys())) {
        if (!seen.has(sessionId)) {
          this.active.items.delete(sessionId);
        }
      }
    });

    onScopeDispose(() => {
      stop();
    });
  }
}

export function useSessionStatusHandlers(): void {
  const host = inject(SessionStatusHostService);
  inject(StateSyncServerService).useHandlers(SessionStatusStateSyncContract, {
    active: () => host.active,
  });
}
