import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type SessionStatusModule = typeof import("../../packages/session-status/src/index.ts");

let harness: HarnessModules;

beforeAll(async () => {
  harness = await createHarnessModules();
});

afterAll(async () => {
  await harness.close();
});

describe("session status variants", () => {
  it("presents a running status and recovers it as failed after a restart", async () => {
    const sessionStatus = await harness.load<SessionStatusModule>(
      "/packages/session-status/src/index.ts",
    );
    const running = sessionStatus.RunningSessionStatus.create({ step: "thinking" });
    expect(running.present()).toMatchObject({
      icon: "i-codicon-loading animate-spin",
      description: "thinking",
      tooltip: "thinking",
    });
    const recovered = running.recover();
    expect(recovered).toBeInstanceOf(sessionStatus.FailedSessionStatus);
    expect(recovered!.present()).toMatchObject({ description: "Failed", tooltip: "Interrupted" });
  });

  it("clears acknowledged terminal statuses but keeps blocked status recoverable", async () => {
    const sessionStatus = await harness.load<SessionStatusModule>(
      "/packages/session-status/src/index.ts",
    );
    expect(sessionStatus.CompletedSessionStatus.create().acknowledge()).toBeUndefined();
    expect(
      sessionStatus.FailedSessionStatus.create({ message: "boom" }).acknowledge(),
    ).toBeUndefined();
    const blocked = sessionStatus.BlockedSessionStatus.create({ reason: "needs input" });
    expect(blocked.present()).toMatchObject({ description: "needs input" });
    expect(blocked.recover()).toBeInstanceOf(sessionStatus.FailedSessionStatus);
  });
});
