import { createRequire } from "node:module";
import { expect, it } from "vite-plus/test";
import { UiStatusBarService } from "../../packages/ui-status-bar/src/index.ts";

const { effectScope, watch } = createRequire(
  new URL("../../packages/ui-status-bar/package.json", import.meta.url),
)("vue") as typeof import("../../packages/ui-status-bar/node_modules/vue/dist/vue.d.ts");

it("revokes a status item when a synchronous observer stops its owner", () => {
  const workbench = effectScope(true);
  const owner = effectScope(true);
  const replacement = effectScope(true);
  const statusBar = workbench.run(() => new UiStatusBarService())!;
  const stopObserving = watch(statusBar.leftItems, () => owner.stop(), { flush: "sync" });

  try {
    owner.run(() => {
      const item = statusBar.useItem({ id: "session-state" });
      item.text = "Retired";
      item.visible = true;
      expect(() => statusBar.useItem({ id: "late" })).toThrow("requires an active EffectScope");
    });

    expect(owner.active).toBe(false);
    expect(statusBar.leftItems.value).toEqual([]);

    replacement.run(() => {
      const item = statusBar.useItem({ id: "session-state" });
      item.text = "Ready";
      item.visible = true;
    });
    expect(statusBar.leftItems.value.map(({ text }) => text)).toEqual(["Ready"]);
    replacement.stop();
    expect(statusBar.leftItems.value).toEqual([]);
  } finally {
    stopObserving();
    owner.stop();
    replacement.stop();
    workbench.stop();
  }
});

it("closes a retired status bar to contributions from a live scope", () => {
  const workbench = effectScope(true);
  const contributor = effectScope(true);
  const nextWorkbench = effectScope(true);
  const statusBar = workbench.run(() => new UiStatusBarService())!;
  const replacement = nextWorkbench.run(() => new UiStatusBarService())!;
  let reentrantError: unknown;

  contributor.run(() => {
    statusBar.useItem({ id: "session-state" }).visible = true;
  });
  const stopObserving = watch(
    statusBar.leftItems,
    () => {
      try {
        contributor.run(() => {
          statusBar.useItem({ id: "session-state" }).visible = true;
        });
      } catch (error) {
        reentrantError = error;
      }
    },
    { flush: "sync", once: true },
  );

  try {
    workbench.stop();
    expect(reentrantError).toEqual(new Error("UiStatusBarService is disposed"));
    expect(() => contributor.run(() => statusBar.useItem())).toThrow(
      "UiStatusBarService is disposed",
    );
    expect(statusBar.leftItems.value).toEqual([]);

    contributor.run(() => {
      const item = replacement.useItem({ id: "session-state" });
      item.text = "Ready";
      item.visible = true;
    });
    expect(replacement.leftItems.value.map(({ text }) => text)).toEqual(["Ready"]);
  } finally {
    stopObserving();
    workbench.stop();
    contributor.stop();
    nextWorkbench.stop();
  }
});
