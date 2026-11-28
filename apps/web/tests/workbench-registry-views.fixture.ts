import { createRootScope } from "@harness/di";
import { UiStorageService } from "@harness/ui-storage";
import { UiTabsService, UiWorkbenchService, type WorkbenchExtension } from "@harness/ui-workbench";
import { watchSyncEffect } from "vue";

export function exerciseExtensionRegistry() {
  const root = createRootScope();
  try {
    root.provideAll([UiStorageService, UiTabsService, UiWorkbenchService]);
    const workbench = root.get(UiWorkbenchService);
    const owner = root.createChild();
    const counts: number[] = [];
    root.run(() => {
      watchSyncEffect(() => {
        counts.push(workbench.extensions.size);
      });
    });

    const extension = { id: "example" };
    owner.run(() => workbench.use(extension));
    const bypassed = (workbench.extensions as Map<string, WorkbenchExtension>).delete(extension.id);
    const retained = workbench.extensions.get(extension.id) === extension;

    owner.dispose();
    return { bypassed, retained, counts };
  } finally {
    root.dispose();
  }
}
