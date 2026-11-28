import { inject } from "@harness/di";
import { StateSyncClientService } from "@harness/state-sync";
import type { VariantConstructor } from "@harness/variants";
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowReactive,
  type ComputedRef,
} from "reactivity";
import {
  SessionStatus,
  SessionStatusStateSyncContract,
  type SessionStatusView,
} from "./variants.ts";

export type { SessionStatusView };

export type SessionStatusPresenter<T extends SessionStatus = SessionStatus> =
  | SessionStatusView
  | ((status: T) => SessionStatusView);

const defaultSessionStatusView: SessionStatusView = {
  icon: "i-codicon-chat-sparkle",
};

export class UiSessionStatusService {
  private readonly sync = inject(StateSyncClientService).use(SessionStatusStateSyncContract);
  private readonly presenters = shallowReactive(
    new Map<VariantConstructor<any>, SessionStatusPresenter<any>>(),
  );

  readonly active: ComputedRef<ReadonlyMap<string, SessionStatus>> = computed(
    () => this.sync.active.items,
  );

  get(sessionId: string): SessionStatus | undefined {
    return this.sync.active.get(sessionId);
  }

  usePresenter<T extends SessionStatus>(
    ctor: VariantConstructor<T>,
    presenter: SessionStatusPresenter<T>,
  ): void {
    if (getCurrentScope() === undefined) {
      throw new Error("usePresenter() requires an active EffectScope");
    }
    this.presenters.set(ctor, presenter);
    onScopeDispose(() => {
      if (this.presenters.get(ctor) === presenter) {
        this.presenters.delete(ctor);
      }
    });
  }

  present(sessionIdOrStatus: string | SessionStatus | undefined): SessionStatusView {
    const status =
      typeof sessionIdOrStatus === "string" ? this.get(sessionIdOrStatus) : sessionIdOrStatus;
    if (status === undefined) return defaultSessionStatusView;
    const presenter = this.presenters.get(status.constructor as VariantConstructor<any>);
    if (presenter !== undefined) {
      return typeof presenter === "function" ? presenter(status) : presenter;
    }
    return status.present();
  }
}
