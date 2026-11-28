```ts
class ChatRunService<TEvent = unknown> {
  readonly isRunning: boolean; // 当前是否有未完成的 run
  start(run: (emit: (event: TEvent) => void, signal: AbortSignal) => Promise<void>): void; // 启动新的 run
  subscribe(signal?: AbortSignal): AsyncIterable<TEvent> | null; // 订阅当前活跃 run（重放已缓冲事件并持续接收实时事件，signal 中止时结束）
  abort(): boolean; // 中止当前活跃 run
}
```
