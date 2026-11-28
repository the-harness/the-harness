```ts
useCodexTools(options?: CodexToolsOptions): void // 按 Codex 顺序注册 exec_command、write_stdin、view_image、web_search，以及可选的 update_plan / apply_patch
useExecCommandTool(options?: CodexToolsOptions): void // 在当前 EffectScope 中注册 exec_command 与 write_stdin
useViewImageTool(options?: CodexToolsOptions): void // 在当前 EffectScope 中注册 view_image；当前模型不支持图片输入时调用返回错误
useUpdatePlanTool(): void // 在当前 EffectScope 中注册 update_plan
useWebSearchTool(): void // 在当前 EffectScope 中注册 web_search；结果由当前模型的 Provider 提供

class ExecJob extends Job<number, void> {
  readonly id: number;
  readonly cmd: string;
  readonly cwd: string;
  readonly shell: string | undefined;
  readonly login: boolean; // 默认 true，使用 <shell> -lc
  readonly tty: boolean; // 仅接受参数；进程始终使用 pipe，不分配 PTY
  readonly exitCode: number | null;
  readonly lastUsedAt: number;
  constructor(id: number, cmd: string, cwd: string, options?: ExecJobOptions);
  write(chars: string): boolean; // 写入 stdin，"\u0003" 发送 SIGINT；返回 false 表示 stdin 已关闭
  collect(yieldTimeMs: number, options?: ExecCollectOptions): Promise<string>; // 等待至多 yieldTimeMs 或进程退出，渲染本次增量输出；仍在运行时自动 yield 交还前台
}

class ExecSessionStore {
  constructor(jobService: JobService, cwdService: CwdService, applyPatch: CodexApplyPatchService, options?: ExecSessionStoreOptions); // 要求活动 EffectScope，Scope 释放时终止本 store 的进程
  execCommand(args: ExecCommandArgs, context?: ExecRequestContext): Promise<string>; // workdir 省略或为空时使用 cwd
  writeStdin(args: WriteStdinArgs, context?: ExecRequestContext): Promise<string>; // session_id 来自 exec_command 的输出
}

interface CodexToolsOptions {
  readonly updatePlan?: boolean; // 默认 false
  readonly viewImage?: boolean; // 默认 true
  readonly webSearch?: boolean; // 默认 true
  readonly maxOutputTokens?: number; // 默认 10000
  readonly backgroundTerminalMaxTimeoutMs?: number; // 默认 300000
  readonly registerApplyPatchTool?: boolean; // 默认 false，注册 JSON 形式的 apply_patch 工具
}

interface ExecJobOptions {
  readonly shell?: string; // 覆盖 $SHELL
  readonly login?: boolean; // 默认 true
  readonly tty?: boolean; // 仅记录
}

interface ExecCollectOptions {
  readonly signal?: AbortSignal;
  readonly reportOutput?: (delta: string) => void; // 流式增量输出
  readonly maxOutputTokens?: number; // 默认 10000
}

interface ExecRequestContext {
  readonly signal?: AbortSignal;
  readonly reportOutput?: (delta: string) => void;
}

interface ExecSessionStoreOptions {
  readonly maxOutputTokens?: number; // 默认 10000
  readonly backgroundTerminalMaxTimeoutMs?: number; // 默认 300000
}
```
