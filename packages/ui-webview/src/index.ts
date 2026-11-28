import { reactive } from "vue";

export { WebviewTabDescriptor } from "./WebviewTab.ts";
export { default as WebviewPanelView } from "./WebviewPanelView.vue";

export interface WebviewState {
  readonly id: string;
  readonly viewType: string;
  title: string;
  html: string;
  enableScripts?: boolean;
  state?: unknown;
  readonly outbox: unknown[];
}

export class UiWebviewService {
  readonly panels = reactive(new Map<string, WebviewState>());
  private readonly messageListeners = new Set<(id: string, message: unknown) => void>();

  create(id: string, viewType: string, title: string): WebviewState {
    const state: WebviewState = { id, viewType, title, html: "", outbox: [], enableScripts: false };
    this.panels.set(id, state);
    return state;
  }

  setHtml(id: string, html: string): void {
    const panel = this.panels.get(id);
    if (panel) panel.html = html;
  }

  postMessage(id: string, message: unknown): void {
    const panel = this.panels.get(id);
    if (panel) panel.outbox.push(message);
  }

  dispose(id: string): void {
    this.panels.delete(id);
  }

  onMessage(listener: (id: string, message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  emitMessage(id: string, message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(id, message);
    }
  }
}
