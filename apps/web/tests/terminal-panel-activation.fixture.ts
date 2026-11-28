import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { TerminalPanel, UiTerminalService } from "@harness/ui-terminal";
import { createApp, h, watch } from "vue";

export async function observePanelActivation() {
  const scope = createRootScope();
  scope.provideAll([UiTerminalService]);
  const terminal = scope.get(UiTerminalService);
  const inventory = Promise.withResolvers<void>();
  const originalFetch = globalThis.fetch;
  let created = 0;
  globalThis.fetch = async (input, init) => {
    if (input !== "/api/terminals") return originalFetch(input, init);
    if (init?.method === "POST") {
      created += 1;
      return new Response(null, { status: 503 });
    }
    await inventory.promise;
    return Response.json([]);
  };

  function mountPanel() {
    const app = createApp({
      setup() {
        provideScope(scope);
        return () => h(TerminalPanel);
      },
    });
    app.mount(document.createElement("div"));
    return app;
  }

  async function waitForInventory() {
    await scope.run(
      () =>
        new Promise<void>((resolve) => {
          const stop = watch(
            terminal.loading,
            (loading) => {
              if (loading) return;
              stop();
              resolve();
            },
            { flush: "sync" },
          );
        }),
    );
    // Let the mounted callback resume after refresh has updated loading.
    await Promise.resolve();
  }

  let panel: ReturnType<typeof mountPanel> | undefined;
  try {
    panel = mountPanel();
    const inventoryPending = terminal.loading.value;
    const firstInventory = waitForInventory();
    panel.unmount();
    panel = undefined;
    inventory.resolve();
    await firstInventory;
    const afterUnmount = created;

    panel = mountPanel();
    await waitForInventory();
    return { inventoryPending, afterUnmount, afterRemount: created };
  } finally {
    panel?.unmount();
    scope.dispose();
    globalThis.fetch = originalFetch;
  }
}
