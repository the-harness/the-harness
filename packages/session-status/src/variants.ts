import { SessionDigest } from "@harness/session-digest";
import { defineStateSyncContract, stateSync } from "@harness/state-sync";
import { ExtensibleVariants, variant } from "@harness/variants";
import { z } from "zod";

export interface SessionStatusView {
  readonly icon: string;
  readonly description?: string;
  readonly badge?: string;
  readonly color?: string;
  readonly tooltip?: string;
}

export abstract class SessionStatus extends ExtensibleVariants {
  abstract present(): SessionStatusView;

  recover(): SessionStatus | undefined {
    return this;
  }

  acknowledge(): SessionStatus | undefined {
    return this;
  }
}

@variant("core:session-status:running")
export class RunningSessionStatus extends SessionStatus {
  declare readonly step?: string;

  override present(): SessionStatusView {
    return {
      icon: "i-codicon-loading animate-spin",
      color: "var(--accent)",
      description: this.step,
      tooltip: this.step ?? "Working",
    };
  }

  override recover(): SessionStatus | undefined {
    return FailedSessionStatus.create({ message: "Interrupted" });
  }
}

@variant("core:session-status:waiting-for-user")
export class WaitingForUserSessionStatus extends SessionStatus {
  declare readonly reason?: string;

  override present(): SessionStatusView {
    return {
      icon: "i-codicon-bell-dot",
      color: "var(--modified)",
      description: this.reason ?? "Waiting",
      tooltip: this.reason ?? "Waiting for user input",
    };
  }
}

@variant("core:session-status:completed")
export class CompletedSessionStatus extends SessionStatus {
  override present(): SessionStatusView {
    return {
      icon: "i-codicon-pass-filled",
      color: "var(--green)",
      tooltip: "Completed",
    };
  }

  override acknowledge(): SessionStatus | undefined {
    return undefined;
  }
}

@variant("core:session-status:failed")
export class FailedSessionStatus extends SessionStatus {
  declare readonly message?: string;

  override present(): SessionStatusView {
    return {
      icon: "i-codicon-error",
      color: "var(--red)",
      description: "Failed",
      tooltip: this.message ?? "Run failed",
    };
  }

  override acknowledge(): SessionStatus | undefined {
    return undefined;
  }
}

export const sessionStatusField = SessionDigest.defineField<SessionStatus>(
  "core:session-status:value",
);

export const SessionStatusStateSyncContract = defineStateSyncContract("session-status", {
  active: stateSync.record(SessionStatus.schema, { readonly: true }),
});
