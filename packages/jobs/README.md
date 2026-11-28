```ts
// R: Result（done 最终返回值）
// H: Handoff（yield 提前交还前台时的返回值，默认与 R 相同）

abstract class Job<R = void, H = R> {
  readonly parent: Job<any, any> | undefined;
  readonly children: ReadonlySet<Job<any, any>>; // 当前子 Job 的实时只读视图
  readonly releaseSignal: AbortSignal;
  readonly abortSignal: AbortSignal;
  readonly foreground: Promise<R | H>; // yield() 或完成时解决
  readonly done: Promise<R>; // 自身及未脱离子树完全结束时解决
  protected abstract run(ctx: JobContext<H>): Promise<R>; // 子类通过自身构造函数与方法定义任意输入输出形式
  spawn<J extends Job<any, any>>(job: J): J; // 挂载并启动子 Job 实例
  detach(target?: Job<any, any>): void; // 脱离当前父级并挂到目标祖先（默认根 Job）
  release(reason?: unknown): Promise<R | H>; // 触发 releaseSignal 并向下传播
  abort(reason?: unknown): Promise<R>; // 触发 abortSignal 并级联终止子树
}

class JobService {
  readonly root: Job<void>; // 此 DI 服务拥有的根 Job，承载整棵任务树
  spawn<J extends Job<any, any>>(job: J): J; // 在服务的根 Job 下启动任务
}

interface JobContext<H = unknown> {
  readonly releaseSignal: AbortSignal; // 调用方释放等待（插话、截止、后台移交），不自动杀掉工作
  readonly abortSignal: AbortSignal; // 真正终止信号，向下级联到未 detach 的子 Job
  yield(handoff: H): void; // 交还前台控制权（foreground 立即解决），Job 本身继续后台运行
  spawn<J extends Job<any, any>>(job: J): J;
  detach(target?: Job<any, any>): void;
}
```
