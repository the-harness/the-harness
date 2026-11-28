import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { OutputPanel, UiOutputService } from "@harness/ui-output";
import { createApp, h, watch } from "vue";

const scope = createRootScope();
scope.provide(UiOutputService);
const output = scope.get(UiOutputService);

createApp({
  setup() {
    provideScope(scope);
    return () => h(OutputPanel);
  },
}).mount(document.body.appendChild(document.createElement("div")));

export function publishWhileDisposingContributor(): void {
  const contributor = scope.createChild();
  const stop = watch(output.channels, () => contributor.dispose(), { flush: "sync" });
  try {
    contributor.run(() => output.useChannel("Build"));
  } finally {
    stop();
  }
}

export function publishBuildOutput(): void {
  const contributor = scope.createChild();
  contributor.run(() => output.useChannel("Build").appendLine("Live build output"));
}

export function retireOutputService(): string | null {
  scope.unprovide(UiOutputService);
  scope.provide(UiOutputService);
  return output.activeChannelId.value;
}

export function publishAfterRetirement(): void {
  scope.run(() => output.useChannel("Late output"));
}
