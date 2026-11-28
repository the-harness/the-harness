import { createServerScope } from "./scope.ts";

export const scope = createServerScope();

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => scope.dispose());
  // A full reload re-evaluates the module graph without running dispose callbacks.
  import.meta.hot.on("vite:beforeFullReload", () => scope.dispose());
}
