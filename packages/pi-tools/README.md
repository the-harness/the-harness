```ts
useReadTool(): void // 在当前 EffectScope 中注册 read 工具
useWriteTool(): void // 在当前 EffectScope 中注册 write 工具
useEditTool(): void // 在当前 EffectScope 中注册 edit 工具
useBashTool(sessionId?: string): void // 在当前 EffectScope 中注册 bash 工具
createBashExecutor(sessionId?: string): (command: string, options: BashExecutionOptions) => Promise<BashExecutionResult> // 在当前作用域的工作目录执行命令，默认使用 Context 的 ID
useGrepTool(): void // 在当前 EffectScope 中注册 grep 工具
useFindTool(): void // 在当前 EffectScope 中注册 find 工具
useLsTool(): void // 在当前 EffectScope 中注册 ls 工具
usePiTools(): void // 在当前 EffectScope 中注册 read、bash、edit、write、grep、find、ls 工具

interface BashExecutionOptions {
  readonly signal: AbortSignal;
  readonly reportOutput?: (delta: string) => void;
  readonly timeout?: number; // 秒
  readonly shellPath?: string;
  readonly operations?: BashOperations;
}

// 可拓展接口：提供 Bash 的底层执行方式
interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      readonly onData: (data: Buffer) => void;
      readonly signal: AbortSignal;
      readonly timeout?: number;
    },
  ): Promise<{ exitCode: number | null }>;
}

interface BashExecutionResult {
  readonly output: string;
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
  readonly truncationNotice?: string;
}
```

```ts
// @harness/pi-tools/ui：工具调用卡片组件
ReadTool / EditTool / WriteTool / BashTool / GrepTool / FindTool / LsTool; // 各工具专用视图
ToolCallView; // 没有专用视图的工具（如 MCP 工具），显示工具名、目标与输出
```
