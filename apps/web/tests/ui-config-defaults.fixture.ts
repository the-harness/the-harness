import { createRootScope, type Scope } from "@harness/di";
import { UiConfigService } from "@harness/ui-config";
import { UiStorageService } from "@harness/ui-storage";
import { watch, watchSyncEffect } from "vue";

function withConfig<T>(run: (config: UiConfigService, scope: Scope) => T): T {
  const scope = createRootScope();
  try {
    scope.provideAll([UiStorageService, UiConfigService]);
    return run(scope.get(UiConfigService), scope);
  } finally {
    scope.dispose();
  }
}

export function observeScopedDefaults() {
  return withConfig((config, scope) => {
    const contributions: Record<string, unknown>[] = [];
    const stop = scope.run(() =>
      watchSyncEffect(() => {
        contributions.push(config.snapshot().defaults);
      }),
    );
    const base = scope.createChild();
    const override = scope.createChild();
    base.run(() => config.useDefaults({ "fixture.size": 2, "fixture.enabled": true }));
    override.run(() => config.useDefaults({ "fixture.size": 8, "fixture.enabled": false }));
    override.dispose();
    stop();

    const snapshot = config.snapshot().defaults;
    snapshot["fixture.size"] = 10;
    const afterSnapshotEdit = config.get("fixture.size");

    config.set("fixture.size", 4);
    config.set("fixture.size", 6, "workspace");
    const workspace = config.get("fixture.size");
    config.set("fixture.size", undefined, "workspace");
    const user = config.get("fixture.size");
    config.set("fixture.size", undefined);
    const fallback = config.get("fixture.size");

    return { contributions, afterSnapshotEdit, workspace, user, fallback };
  });
}

export function disposeDuringDefaultPublication() {
  return withConfig((config, scope) => {
    const owner = scope.createChild();
    let published: Record<string, unknown> | undefined;
    scope.run(() =>
      watch(
        () => config.has("fixture.ready"),
        (ready) => {
          if (!ready) return;
          published = config.snapshot().defaults;
          owner.dispose();
        },
        { flush: "sync" },
      ),
    );

    owner.run(() => config.useDefaults({ "fixture.ready": true, "fixture.count": 42 }));
    return { published, remaining: config.snapshot().defaults, disposed: owner.isDisposed };
  });
}
