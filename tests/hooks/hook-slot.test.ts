import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type HooksModule = typeof import("../../packages/hooks/src/index.ts");
type ReactivityModule = typeof import("reactivity");

let harness: HarnessModules;
let hooks: HooksModule;
let reactivity: ReactivityModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [hooks, reactivity] = await Promise.all([
    harness.load<HooksModule>("/packages/hooks/src/index.ts"),
    harness.load<ReactivityModule>("/packages/llm/node_modules/reactivity/dist/index.js"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function liveScope() {
  const scope = reactivity.effectScope();
  return {
    scope,
    run<T>(fn: () => T): T {
      return scope.run(fn)!;
    },
    stop(): void {
      scope.stop();
    },
  };
}

describe("HookSlot onion dispatch", () => {
  it("runs handlers in registration order and folds results back in reverse order", async () => {
    const slot = new hooks.HookSlot<{ value: number }, number>();
    const owner = liveScope();
    const events: string[] = [];
    try {
      owner.run(() => {
        slot.use(async (_input, next) => {
          events.push("a:in");
          const result = await next();
          events.push("a:out");
          return result + 1;
        });
        slot.use(async (_input, next) => {
          events.push("b:in");
          const result = await next();
          events.push("b:out");
          return result * 10;
        });
      });

      const result = await slot.run({ value: 1 }, async (input) => {
        events.push("terminal");
        return input.value;
      });

      expect(result).toBe(11);
      expect(events).toEqual(["a:in", "b:in", "terminal", "b:out", "a:out"]);
    } finally {
      owner.stop();
    }
  });

  it("runs the terminal directly when nothing is registered and returns undefined without one", async () => {
    const slot = new hooks.HookSlot<number, string>();
    expect(await slot.run(7, async (input) => `value:${input}`)).toBe("value:7");

    const voidSlot = new hooks.HookSlot<number>();
    expect(await voidSlot.run(7)).toBeUndefined();
  });

  it("skips downstream handlers and the terminal when a handler does not call next", async () => {
    const slot = new hooks.HookSlot<number, string>();
    const owner = liveScope();
    const events: string[] = [];
    try {
      owner.run(() => {
        slot.use(() => {
          events.push("veto");
          return "short-circuited";
        });
        slot.use(async (_input, next) => {
          events.push("downstream");
          return next();
        });
      });

      const result = await slot.run(1, async () => {
        events.push("terminal");
        return "terminal";
      });

      expect(result).toBe("short-circuited");
      expect(events).toEqual(["veto"]);
    } finally {
      owner.stop();
    }
  });

  it("re-runs the remaining chain and terminal on every next call", async () => {
    const slot = new hooks.HookSlot<{ attempt: number }, string>();
    const owner = liveScope();
    const attempts: number[] = [];
    try {
      owner.run(() =>
        slot.use(async (_input, next) => {
          await next({ attempt: 1 });
          return next({ attempt: 2 });
        }),
      );
      owner.run(() =>
        slot.use(async (input, next) => {
          attempts.push(input.attempt);
          return next();
        }),
      );

      const result = await slot.run({ attempt: 0 }, async (input) => `attempt:${input.attempt}`);

      expect(attempts).toEqual([1, 2]);
      expect(result).toBe("attempt:2");
    } finally {
      owner.stop();
    }
  });

  it("forks the downstream input with next(override) without changing the current input", async () => {
    const slot = new hooks.HookSlot<{ value: number }, number>();
    const owner = liveScope();
    const raw = { value: 1 };
    let seenByHandlerAfterNext: number | undefined;
    let seenDownstream: number | undefined;
    try {
      owner.run(() =>
        slot.use(async (input, next) => {
          await next({ value: 42 });
          seenByHandlerAfterNext = input.value;
          return input.value;
        }),
      );
      owner.run(() =>
        slot.use(async (input, next) => {
          seenDownstream = input.value;
          return next();
        }),
      );

      const result = await slot.run(raw, async (input) => input.value);

      expect(seenDownstream).toBe(42);
      expect(seenByHandlerAfterNext).toBe(1);
      expect(result).toBe(1);
      expect(raw.value).toBe(1);
    } finally {
      owner.stop();
    }
  });

  it("keeps each concurrent run on its own registration snapshot", async () => {
    const slot = new hooks.HookSlot<{ id: string }, string>();
    const owner = liveScope();
    const seen: string[] = [];
    try {
      owner.run(() =>
        slot.use(async (input, next) => {
          await Promise.resolve();
          seen.push(`a:${input.id}`);
          return next();
        }),
      );
      owner.run(() =>
        slot.use(async (input, next) => {
          seen.push(`b:${input.id}`);
          return next();
        }),
      );

      const results = await Promise.all([
        slot.run({ id: "first" }, async (input) => input.id),
        slot.run({ id: "second" }, async (input) => input.id),
      ]);

      expect(results).toEqual(["first", "second"]);
      expect(seen.sort()).toEqual(["a:first", "a:second", "b:first", "b:second"]);
    } finally {
      owner.stop();
    }
  });
});

describe("HookSlot registration", () => {
  it("honours before and after anchors relative to registered handlers", async () => {
    const slot = new hooks.HookSlot<undefined, string>();
    const owner = liveScope();
    const order: string[] = [];
    const handler = (label: string) => async (_input: undefined, next: () => Promise<string>) => {
      order.push(label);
      return next();
    };
    try {
      owner.run(() => {
        const a = slot.use(handler("a"));
        const c = slot.use(handler("c"));
        slot.use(handler("b"), { before: c });
        slot.use(handler("d"), { after: a });
        slot.use(handler("first"), { before: a });
      });

      await slot.run(undefined, async () => "done");

      expect(order).toEqual(["first", "a", "d", "b", "c"]);
    } finally {
      owner.stop();
    }
  });

  it("rejects conflicting or unknown positions instead of silently appending", () => {
    const slot = new hooks.HookSlot<undefined>();
    const owner = liveScope();
    try {
      owner.run(() => {
        const otherAnchor = slot.use(() => {});
        expect(() => slot.use(() => {}, { before: otherAnchor, after: otherAnchor })).toThrow(
          "Hook registration cannot specify both before and after",
        );
        expect(() => slot.use(() => {}, { before: Object.freeze({}) as never })).toThrow(
          "Hook anchor target is not registered in this slot",
        );
        expect(() => slot.use(() => {}, { after: Object.freeze({}) as never })).toThrow(
          "Hook anchor target is not registered in this slot",
        );
      });
    } finally {
      owner.stop();
    }
  });

  it("disposes registrations idempotently without disturbing neighbours", async () => {
    const slot = new hooks.HookSlot<number, number>();
    const order: string[] = [];
    const make = (label: string) => async (_input: number, next: () => Promise<number>) => {
      order.push(label);
      return next();
    };
    const a = liveScope();
    const b = liveScope();
    const c = liveScope();
    try {
      a.run(() => slot.use(make("a")));
      b.run(() => slot.use(make("b")));
      c.run(() => slot.use(make("c")));

      a.stop();
      a.stop();
      await slot.run(1, async () => 1);
      expect(order).toEqual(["b", "c"]);

      b.stop();
      await slot.run(1, async () => 1);
      expect(order).toEqual(["b", "c", "c"]);
    } finally {
      c.stop();
    }
  });

  it("takes a snapshot at run start so registration and disposal do not affect an in-flight run", async () => {
    const slot = new hooks.HookSlot<number, string>();
    const owner = liveScope();
    const late = liveScope();
    const removed = liveScope();
    const events: string[] = [];
    try {
      let added = false;
      owner.run(() =>
        slot.use(async (_input, next) => {
          events.push("before");
          if (!added) {
            added = true;
            late.run(() =>
              slot.use(async (_input, next) => {
                events.push("late");
                return next();
              }),
            );
          }
          removed.stop();
          const result = await next();
          events.push("after");
          return result;
        }),
      );
      removed.run(() =>
        slot.use(async (_input, next) => {
          events.push("removed");
          return next();
        }),
      );

      const first = await slot.run(1, async () => {
        events.push("terminal");
        return "terminal";
      });
      expect(first).toBe("terminal");
      expect(events).toEqual(["before", "removed", "terminal", "after"]);

      events.length = 0;
      const second = await slot.run(1, async () => {
        events.push("terminal");
        return "terminal";
      });
      expect(second).toBe("terminal");
      expect(events).toEqual(["before", "late", "terminal", "after"]);
    } finally {
      owner.stop();
      late.stop();
    }
  });

  it("propagates errors from handlers and terminals without running the rest of the model", async () => {
    const slot = new hooks.HookSlot<number, number>();
    const owner = liveScope();
    const events: string[] = [];
    try {
      owner.run(() => {
        slot.use(async () => {
          events.push("throwing");
          throw new Error("handler failed");
        });
        slot.use(async (_input, next) => {
          events.push("downstream");
          return next();
        });
      });

      await expect(
        slot.run(1, async () => {
          events.push("terminal");
          return 1;
        }),
      ).rejects.toThrow("handler failed");
      expect(events).toEqual(["throwing"]);

      const terminalSlot = new hooks.HookSlot<number, number>();
      const terminalOwner = liveScope();
      try {
        terminalOwner.run(() => terminalSlot.use(async (_input, next) => next()));
        await expect(
          terminalSlot.run(1, async () => {
            throw new Error("terminal failed");
          }),
        ).rejects.toThrow("terminal failed");
      } finally {
        terminalOwner.stop();
      }
    } finally {
      owner.stop();
    }
  });
});
