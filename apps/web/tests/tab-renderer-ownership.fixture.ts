import { createRootScope } from "@harness/di";
import { UiStorageService } from "@harness/ui-storage";
import { TabDescriptor, UiTabsService, type TabRenderer } from "@harness/ui-workbench";
import { watchSyncEffect } from "vue";

class ExampleTab extends TabDescriptor {
  get key(): string {
    return "example";
  }

  get defaultTitle(): string {
    return "Example";
  }
}

export function observeRendererOwnership() {
  const scope = createRootScope();
  try {
    scope.provideAll([UiStorageService, UiTabsService]);
    const tabs = scope.get(UiTabsService);
    const descriptor = new ExampleTab();
    const renderer: TabRenderer<ExampleTab> = { descriptor: ExampleTab, component: () => null };
    const first = scope.createChild();
    const second = scope.createChild();
    first.run(() => tabs.useRenderer(renderer));
    second.run(() => tabs.useRenderer(renderer));
    first.dispose();
    const replacementRetained = tabs.getRenderer(descriptor) === renderer;
    second.dispose();
    const replacementReleased = tabs.getRenderer(descriptor) === undefined;

    const observed = scope.createChild();
    let published = false;
    scope.run(() => {
      watchSyncEffect(() => {
        if (tabs.getRenderer(descriptor) === renderer) {
          published = true;
          observed.dispose();
        }
      });
    });
    observed.run(() => tabs.useRenderer(renderer));
    return {
      replacementRetained,
      replacementReleased,
      published,
      disposedDuringPublication: observed.isDisposed,
      releasedDuringPublication: tabs.getRenderer(descriptor) === undefined,
    };
  } finally {
    scope.dispose();
  }
}
