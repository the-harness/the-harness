import { reactive } from "vue";
import type { UiWebviewService } from "@harness/ui-webview";

export interface WebviewState {
  readonly id: string;
  readonly viewType: string;
  title: string;
  html: string;
  enableScripts?: boolean;
  readonly outbox: unknown[];
}

export function createMainThreadWebview(
  store?: Pick<UiWebviewService, "panels">,
  events?: {
    show(panel: WebviewState, column?: number, preserveFocus?: boolean): void;
    dispose(id: string): void;
    title(id: string, title: string): void;
  },
) {
  const panels = store?.panels ?? reactive(new Map<string, WebviewState>());

  const handle = (method: string, args: unknown[]): boolean => {
    if (method === "webview.create") {
      const [id, viewType, title, showOptions, options] = args as [
        string,
        string,
        string,
        number | { viewColumn?: number; preserveFocus?: boolean } | undefined,
        { enableScripts?: boolean } | undefined,
      ];
      const panel = {
        id,
        viewType,
        title,
        html: "",
        outbox: [],
        enableScripts: !!options?.enableScripts,
      };
      panels.set(id, panel);
      events?.show(
        panel,
        typeof showOptions === "number" ? showOptions : showOptions?.viewColumn,
        typeof showOptions === "object" ? showOptions.preserveFocus : false,
      );
      return true;
    }
    if (method === "webview.setOptions") {
      const panel = panels.get(String(args[0]));
      if (panel) panel.enableScripts = !!(args[1] as { enableScripts?: boolean })?.enableScripts;
      return true;
    }
    if (method === "webview.setTitle") {
      const panel = panels.get(String(args[0]));
      if (panel) {
        panel.title = String(args[1]);
        events?.title(panel.id, panel.title);
      }
      return true;
    }
    if (method === "webview.reveal") {
      const panel = panels.get(String(args[0]));
      if (panel) events?.show(panel, args[1] as number | undefined, !!args[2]);
      return true;
    }
    if (method === "webview.setHtml") {
      const [id, html] = args as [string, string];
      const panel = panels.get(id);
      if (panel) panel.html = html;
      return true;
    }
    if (method === "webview.postMessage") {
      const [id, message] = args as [string, unknown];
      const panel = panels.get(id);
      if (panel) panel.outbox.push(message);
      return true;
    }
    if (method === "webview.dispose") {
      const [id] = args as [string];
      panels.delete(id);
      events?.dispose(id);
      return true;
    }
    return false;
  };

  return { panels, handle };
}
