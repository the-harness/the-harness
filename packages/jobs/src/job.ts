import { getCurrentScope, onScopeDispose, shallowReadonly } from "reactivity";

/**
 * @template H Handoff — `yield` 提前交还前台时的返回值类型
 */
export interface JobContext<H = unknown> {
  readonly releaseSignal: AbortSignal;
  readonly abortSignal: AbortSignal;
  yield(handoff: H): void;
  spawn<J extends Job<any, any>>(job: J): J;
  detach(target?: Job<any, any>): void;
}

/**
 * @template R Result — `done` 最终返回值类型
 * @template H Handoff — `yield` 提前交还前台时的返回值类型（默认与 R 相同）
 */
export abstract class Job<R = void, H = R> {
  readonly foreground: Promise<R | H>;
  readonly done: Promise<R>;

  private readonly releaseController = new AbortController();
  private readonly abortController = new AbortController();
  private readonly _children = new Set<Job<any, any>>();

  private _parent: Job<any, any> | undefined;
  private started = false;
  private acceptingChildren = true;
  private settled = false;
  private foregroundSettled = false;
  private resolveForeground!: (value: R | H) => void;
  private rejectForeground!: (reason: unknown) => void;
  private resolveDone!: (value: R) => void;
  private rejectDone!: (reason: unknown) => void;

  constructor() {
    this.foreground = new Promise<R | H>((resolve, reject) => {
      this.resolveForeground = resolve;
      this.rejectForeground = reject;
    });
    this.done = new Promise<R>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // 后台运行的 job 仅被 await foreground 时，避免后台失败直接触发未处理 rejection 崩溃
    this.foreground.catch(() => {});
    this.done.catch(() => {});
  }

  get parent(): Job<any, any> | undefined {
    return this._parent;
  }

  get children(): ReadonlySet<Job<any, any>> {
    return shallowReadonly(this._children);
  }

  get releaseSignal(): AbortSignal {
    return this.releaseController.signal;
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  protected abstract run(ctx: JobContext<H>): Promise<R>;

  spawn<J extends Job<any, any>>(job: J): J {
    if (this.abortController.signal.aborted || !this.acceptingChildren) {
      throw new Error("Cannot spawn child job on a closing or settled job");
    }
    if (job.started || job._parent) {
      throw new Error("Cannot spawn an already started or attached job");
    }
    for (let ancestor: Job<any, any> | undefined = this; ancestor; ancestor = ancestor._parent) {
      if (ancestor === job) throw new Error("Cannot spawn a job into itself or its descendant");
    }
    job._parent = this;
    this._children.add(job);
    return job.start();
  }

  detach(target?: Job<any, any>): void {
    if (this.settled || !this.acceptingChildren || !this._parent) return;
    const nextParent = target ?? this.findRoot();
    if (nextParent.settled || !nextParent.acceptingChildren) {
      throw new Error("Target parent job is not accepting children");
    }
    for (let cur: Job<any, any> | undefined = nextParent; cur; cur = cur._parent) {
      if (cur === this) throw new Error("Cannot detach job into itself or its descendant");
    }
    if (nextParent === this._parent) return;
    this._parent._children.delete(this);
    nextParent._children.add(this);
    this._parent = nextParent;
  }

  release(reason?: unknown): Promise<R | H> {
    if (!this.settled && !this.releaseController.signal.aborted) {
      this.releaseController.abort(reason);
      for (const child of Array.from(this._children)) {
        void child.release(reason);
      }
    }
    return this.foreground;
  }

  abort(reason?: unknown): Promise<R> {
    if (!this.settled && !this.abortController.signal.aborted) {
      this.abortController.abort(reason);
      for (const child of Array.from(this._children)) {
        void child.abort(reason);
      }
    }
    return this.done;
  }

  private start(): this {
    if (this.started) {
      throw new Error("Job has already started");
    }
    this.started = true;
    const ctx: JobContext<H> = {
      releaseSignal: this.releaseController.signal,
      abortSignal: this.abortController.signal,
      yield: (handoff) => {
        if (this.foregroundSettled) return;
        this.foregroundSettled = true;
        this.resolveForeground(handoff);
      },
      spawn: (job) => this.spawn(job),
      detach: (target) => this.detach(target),
    };

    let runPromise: Promise<R>;
    try {
      runPromise = Promise.resolve(this.run(ctx));
    } catch (error) {
      runPromise = Promise.reject(error);
    }

    void runPromise.then(
      (value) => this.finish({ ok: true, value }),
      (error: unknown) => this.finish({ ok: false, error }),
    );
    return this;
  }

  private findRoot(): Job<any, any> {
    return this._parent ? this._parent.findRoot() : this;
  }

  private async finish(
    result:
      | { readonly ok: true; readonly value: R }
      | { readonly ok: false; readonly error: unknown },
  ): Promise<void> {
    this.acceptingChildren = false;
    const snapshot = Array.from(this._children);
    if (!result.ok) {
      for (const child of snapshot) void child.abort(result.error);
    }
    if (snapshot.length > 0) {
      await Promise.allSettled(snapshot.map((child) => child.done));
    }

    this.settled = true;
    this._parent?._children.delete(this);

    if (result.ok) {
      if (!this.foregroundSettled) {
        this.foregroundSettled = true;
        this.resolveForeground(result.value);
      }
      this.resolveDone(result.value);
    } else {
      if (!this.foregroundSettled) {
        this.foregroundSettled = true;
        this.rejectForeground(result.error);
      }
      this.rejectDone(result.error);
    }
  }

  protected static startRoot(job: Job<any, any>): void {
    job.start();
    if (getCurrentScope()?.active) {
      onScopeDispose(() => {
        job.acceptingChildren = false;
        void job.release("disposed");
      });
    }
  }
}

class JobRoot extends Job<void> {
  constructor() {
    super();
    JobRoot.startRoot(this);
  }

  protected run(ctx: JobContext<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (ctx.abortSignal.aborted) {
        reject(ctx.abortSignal.reason);
        return;
      }
      ctx.abortSignal.addEventListener("abort", () => reject(ctx.abortSignal.reason), {
        once: true,
      });
      ctx.releaseSignal.addEventListener(
        "abort",
        () => {
          if (ctx.abortSignal.aborted) return;
          resolve();
        },
        { once: true },
      );
    });
  }
}

export class JobService {
  readonly root: Job<void> = new JobRoot();

  spawn<J extends Job<any, any>>(job: J): J {
    return this.root.spawn(job);
  }
}
