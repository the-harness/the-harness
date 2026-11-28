import { createDescriptor, createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { TabContext } from "@harness/ui-workbench";
import { UiWebviewService, WebviewPanelView, WebviewTabDescriptor } from "@harness/ui-webview";
import { createMainThreadWebview } from "../../../packages/vscode-ext-host/src/main-thread/webview.ts";
import { createApp, h } from "vue";

const views = new Map<string, () => void>();
const rootScope = createRootScope();
rootScope.provide(UiWebviewService, UiWebviewService);
const store = rootScope.get(UiWebviewService);
store.onMessage((id, message) =>
  (
    window as typeof window & {
      dispatchWebviewMessage(id: string, message: unknown): Promise<void>;
    }
  ).dispatchWebviewMessage(id, message),
);
const main = createMainThreadWebview(store, {
  show(panel) {
    if (views.has(panel.id)) return;
    const scope = rootScope.createChild();
    scope.provide(
      TabContext,
      createDescriptor(TabContext, {
        descriptor: new WebviewTabDescriptor({ webviewId: panel.id, title: panel.title }),
      } as never),
    );
    const element = document.createElement("div");
    element.dataset.webview = panel.id;
    element.style.cssText = "height:500px;width:900px";
    document.body.append(element);
    const app = createApp({
      setup() {
        provideScope(scope);
        return () => h(WebviewPanelView);
      },
    });
    app.mount(element);
    views.set(panel.id, () => {
      app.unmount();
      scope.dispose();
      element.remove();
    });
  },
  dispose(id) {
    views.get(id)?.();
    views.delete(id);
  },
  title() {},
});

export function dispatchWebview(method: string, args: unknown[]) {
  if (!main.handle(method, args)) throw new Error(`Unknown webview call: ${method}`);
  return true;
}
export function panels() {
  return [...main.panels.values()].map(({ id, title, html, enableScripts }) => ({
    id,
    title,
    html,
    enableScripts,
  }));
}
export function disposeWebviews() {
  for (const dispose of views.values()) dispose();
  views.clear();
  main.panels.clear();
}
