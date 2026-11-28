import { describe, expect, it, vi } from "vite-plus/test";
import { createRootScope } from "../../packages/di/src/index.ts";
import { Job, JobService, type JobContext } from "../../packages/jobs/src/index.ts";

class FunctionJob<R, H = R> extends Job<R, H> {
  constructor(private readonly body: (ctx: JobContext<H>) => Promise<R>) {
    super();
  }

  protected override run(ctx: JobContext<H>): Promise<R> {
    return this.body(ctx);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("keeps an unstarted ancestor available after rejecting a cyclic spawn", async () => {
  const parent = new FunctionJob<void>(async () => {});
  expect(() => parent.spawn(parent)).toThrow("Cannot spawn a job into itself or its descendant");

  const child = parent.spawn(new FunctionJob<void>(async () => {}));
  expect(() => child.spawn(parent)).toThrow("Cannot spawn a job into itself or its descendant");
  expect(parent.parent).toBeUndefined();
  await expect(child.done).resolves.toBeUndefined();

  const running = new JobService().spawn(parent);
  const root = running.parent!;
  try {
    await expect(running.done).resolves.toBeUndefined();
  } finally {
    await root.abort("cleanup").catch(() => {});
  }
});

function abortFailure(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function outcome(job: Job<any, any>): Promise<"resolved" | "rejected"> {
  try {
    await job.done;
    return "resolved";
  } catch {
    return "rejected";
  }
}

async function cleanup(root: Job<void>): Promise<void> {
  void root.abort("cleanup");
  await outcome(root);
}

describe("job runtime", () => {
  it("retires the DI job root before releasing its existing children", async () => {
    const scope = createRootScope();
    scope.provide(JobService);
    const service = scope.get(JobService);
    const { root } = service;
    const finish = deferred<string>();
    const active = service.spawn(new FunctionJob(() => finish.promise));
    const late = () => new FunctionJob(async () => "unexpected");
    let releaseError: unknown;
    root.releaseSignal.addEventListener(
      "abort",
      () => {
        try {
          root.spawn(late());
        } catch (error) {
          releaseError = error;
        }
      },
      { once: true },
    );

    try {
      scope.dispose();
      const message = "Cannot spawn child job on a closing or settled job";
      expect(releaseError).toMatchObject({ message });
      expect(() => root.spawn(late())).toThrow(message);
      expect(() => service.spawn(late())).toThrow(message);
      expect(root.children.has(active)).toBe(true);
      expect(active.releaseSignal.aborted).toBe(true);
      expect(active.abortSignal.aborted).toBe(false);

      finish.resolve("finished");
      await expect(active.done).resolves.toBe("finished");
    } finally {
      finish.resolve("finished");
      scope.dispose();
      await root.done;
    }
  });

  it("resolves foreground on yield while done waits for the background result", async () => {
    const root = new JobService().root;
    const gate = deferred();
    const job = root.spawn(
      new FunctionJob<string, string>(async (ctx) => {
        ctx.yield("handoff");
        await gate.promise;
        return "finished";
      }),
    );

    expect(await job.foreground).toBe("handoff");
    let done = false;
    void job.done.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    gate.resolve();
    expect(await job.done).toBe("finished");
    await cleanup(root);
  });

  it("aborts a whole subtree, settles after children and rejects later spawns", async () => {
    const root = new JobService().root;
    const childStarted = deferred();
    const childFinished = deferred();
    const childAborted = deferred<unknown>();
    let child!: Job<void>;
    let childSettled = false;

    const parent = root.spawn(
      new FunctionJob<void>(async (ctx) => {
        child = ctx.spawn(
          new FunctionJob<void>(async (childCtx) => {
            childCtx.abortSignal.addEventListener("abort", () => childAborted.resolve(undefined), {
              once: true,
            });
            childStarted.resolve();
            await childFinished.promise;
            childSettled = true;
          }),
        );
        await abortFailure(ctx.abortSignal);
      }),
    );

    await childStarted.promise;
    expect(parent.children.has(child)).toBe(true);
    expect(child.parent).toBe(parent);

    const reason = new Error("stop now");
    void parent.abort(reason);
    const settled = outcome(parent);
    expect(await childAborted.promise).toBeUndefined();
    childFinished.resolve();
    expect(await settled).toBe("rejected");
    expect(await outcome(child)).toBe("resolved");
    expect(childSettled).toBe(true);
    expect(parent.children.size).toBe(0);
    expect(() => parent.spawn(new FunctionJob(async () => {}))).toThrow(
      "Cannot spawn child job on a closing or settled job",
    );

    await cleanup(root);
  });

  it("detaches a child so an ancestor abort no longer reaches it", async () => {
    const root = new JobService().root;
    const childStarted = deferred();
    const childAborted = deferred<unknown>();
    const parent = root.spawn(
      new FunctionJob<void>(async (ctx) => {
        const child = ctx.spawn(
          new FunctionJob<void>(async (childCtx) => {
            childStarted.resolve();
            childCtx.abortSignal.addEventListener("abort", () => childAborted.resolve(undefined), {
              once: true,
            });
            await abortFailure(childCtx.abortSignal);
          }),
        );
        child.detach();
        await abortFailure(ctx.abortSignal);
      }),
    );

    await childStarted.promise;
    const child = [...root.children].find((entry) => entry !== parent)!;
    expect(child.parent).toBe(root);
    expect(parent.children.size).toBe(0);

    void parent.abort("parent only");
    expect(await outcome(parent)).toBe("rejected");
    expect(child.abortSignal.aborted).toBe(false);

    void root.abort("root");
    expect(await childAborted.promise).toBeUndefined();
    expect(await outcome(child)).toBe("rejected");
  });

  it("rejects detaching into a descendant and into a settled target", async () => {
    const root = new JobService().root;
    const gate = deferred();
    let child!: Job<void>;
    let inner!: Job<void>;

    const parent = root.spawn(
      new FunctionJob<void>(async (ctx) => {
        child = ctx.spawn(
          new FunctionJob<void>(async (childCtx) => {
            inner = childCtx.spawn(new FunctionJob(async () => {}));
            await gate.promise;
          }),
        );
        await abortFailure(ctx.abortSignal);
      }),
    );

    expect(() => parent.detach(child)).toThrow("Cannot detach job into itself or its descendant");
    child.detach();

    void parent.abort("stop");
    expect(await outcome(parent)).toBe("rejected");
    expect(() => child.detach(parent)).toThrow("Target parent job is not accepting children");

    gate.resolve();
    expect(await inner.done).toBeUndefined();
    await cleanup(root);
  });

  it("releases the foreground signal without aborting background work", async () => {
    const root = new JobService().root;
    const released = deferred();
    const abortSeen = { value: false };

    const job = root.spawn(
      new FunctionJob<string>(async (ctx) => {
        ctx.releaseSignal.addEventListener("abort", () => released.resolve(), { once: true });
        ctx.abortSignal.addEventListener("abort", () => {
          abortSeen.value = true;
        });
        await released.promise;
        return "kept working";
      }),
    );

    expect(await root.release("user took over")).toBeUndefined();
    expect(await released.promise).toBeUndefined();
    expect(job.releaseSignal.aborted).toBe(true);
    expect(job.abortSignal.aborted).toBe(false);
    expect(await job.done).toBe("kept working");
    expect(abortSeen.value).toBe(false);
    await cleanup(root);
  });

  it("aborts children when the parent fails and waits for the subtree to settle", async () => {
    const root = new JobService().root;
    const childStarted = deferred();
    const failNow = deferred();
    const childAbort = deferred();
    const childFinish = deferred();
    const events: string[] = [];

    const parent = root.spawn(
      new FunctionJob<void>(async (ctx) => {
        ctx.spawn(
          new FunctionJob<void>(async (childCtx) => {
            childStarted.resolve();
            childCtx.abortSignal.addEventListener(
              "abort",
              () => {
                events.push("child:abort");
                childAbort.resolve();
              },
              { once: true },
            );
            await childFinish.promise;
            events.push("child:done");
          }),
        );
        await failNow.promise;
        throw new Error("parent failed");
      }),
    );

    await childStarted.promise;
    const settled = outcome(parent);
    failNow.resolve();
    await childAbort.promise;
    expect(parent.children.size).toBe(1);
    childFinish.resolve();
    expect(await settled).toBe("rejected");
    expect(events).toEqual(["child:abort", "child:done"]);
    expect(parent.children.size).toBe(0);
    await cleanup(root);
  });

  it("rejects spawning an already started job", async () => {
    const root = new JobService().root;
    const gate = deferred();
    const running = new FunctionJob<void>(async () => {
      await gate.promise;
    });
    root.spawn(running);
    expect(() => root.spawn(running)).toThrow("Cannot spawn an already started or attached job");
    gate.resolve();
    expect(await running.done).toBeUndefined();
    await cleanup(root);
  });

  it("keeps child cancellation behind the readonly job tree", async () => {
    const child = new FunctionJob<void>(async ({ abortSignal }) => abortFailure(abortSignal));
    const parent = new JobService().spawn(
      new FunctionJob<void>(async ({ spawn, abortSignal }) => {
        spawn(child);
        await abortFailure(abortSignal);
      }),
    );
    const root = parent.parent!;
    const children = parent.children;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(children.has(child)).toBe(true);
      (children as Set<Job<void>>).delete(child);
      expect(children.has(child)).toBe(true);

      const reason = new Error("parent canceled");
      const canceled = parent.abort(reason);
      await expect(child.done).rejects.toBe(reason);
      await expect(canceled).rejects.toBe(reason);
      expect(children.size).toBe(0);
    } finally {
      warn.mockRestore();
      await child.abort("cleanup").catch(() => {});
      await root.abort("cleanup").catch(() => {});
    }
  });
});
