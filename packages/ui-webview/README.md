```ts
interface WebviewState {
  readonly id: string;
  readonly viewType: string;
  title: string;
  html: string;
  enableScripts?: boolean; // 控制隔离 iframe 的脚本执行和 acquireVsCodeApi 注入
  state?: unknown; // Webview setState/getState 的面板内持久状态
  readonly outbox: unknown[];
}

class UiWebviewService {
  readonly panels: Map<string, WebviewState>;
  create(id: string, viewType: string, title: string): WebviewState;
  setHtml(id: string, html: string): void;
  postMessage(id: string, message: unknown): void;
  dispose(id: string): void;
  onMessage(listener: (id: string, message: unknown) => void): () => void;
  emitMessage(id: string, message: unknown): void;
}
```
