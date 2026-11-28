import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { TerminalPanel, UiTerminalService } from "@harness/ui-terminal";
import { createApp, h } from "vue";
import "virtual:uno.css";
import "../src/style.css";

const scope = createRootScope();
scope.provideAll([UiTerminalService]);

createApp({
  setup() {
    provideScope(scope);
    return () => h(TerminalPanel);
  },
}).mount("#app");
