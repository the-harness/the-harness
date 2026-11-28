import { describe, expect, test } from "vite-plus/test";
import { createIdempotentArbiter, createKeyedQueue } from "../packages/gateway/src/index.ts";

describe("gateway multi-surface concurrency", () => {
  test("serializes concurrent operations for the same session key without blocking others", async () => {
    const queue = createKeyedQueue();
    const events: string[] = [];

    const p1 = queue.run("session-a", async () => {
      events.push("a1:start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("a1:end");
      return 1;
    });

    const p2 = queue.run("session-a", async () => {
      events.push("a2:start");
      events.push("a2:end");
      return 2;
    });

    const p3 = queue.run("session-b", async () => {
      events.push("b1:start");
      events.push("b1:end");
      return 3;
    });

    expect(await Promise.all([p1, p2, p3])).toEqual([1, 2, 3]);
    expect(events.indexOf("a1:end")).toBeLessThan(events.indexOf("a2:start"));
    expect(events.indexOf("b1:end")).toBeLessThan(events.indexOf("a1:end"));
  });

  test("arbitrates concurrent approval claims idempotently (first wins)", async () => {
    const arbiter = createIdempotentArbiter();

    const [r1, r2] = await Promise.all([
      arbiter.claim("approval-1", async () => "approved-by-desktop"),
      arbiter.claim("approval-1", async () => "rejected-by-mobile"),
    ]);

    expect(r1).toEqual({ claimed: true, result: "approved-by-desktop" });
    expect(r2).toEqual({ claimed: false });
  });
});
