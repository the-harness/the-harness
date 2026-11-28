import {
  initTheme,
  SessionSelectorComponent,
  SettingsManager,
  type InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, setKeybindings, TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import type { SessionCatalog } from "./session-catalog.ts";

type SelectorOptions = NonNullable<ConstructorParameters<typeof SessionSelectorComponent>[6]>;

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = await import(new URL("core/keybindings.js", sdk).href) as {
  KeybindingsManager: { create(agentDir?: string): NonNullable<SelectorOptions["keybindings"]> };
};

function createSelector(
  catalog: SessionCatalog,
  cwd: string,
  handlers: {
    readonly select: (id: string) => void;
    readonly cancel: () => void;
    readonly exit: () => void;
    readonly render: () => void;
    readonly rename?: SelectorOptions["renameSession"];
    readonly keybindings?: SelectorOptions["keybindings"];
    readonly showRenameHint?: boolean;
    readonly currentId?: string;
  },
) {
  const selector = new SessionSelectorComponent(
    (report, signal) => catalog.list(cwd, report, signal),
    (report, signal) => catalog.list(undefined, report, signal),
    handlers.select,
    handlers.cancel,
    handlers.exit,
    handlers.render,
    {
      renameSession: handlers.rename,
      keybindings: handlers.keybindings,
      showRenameHint: handlers.showRenameHint,
    },
    handlers.currentId,
  );
  const list = selector.getSessionList();
  list.onDeleteSession = async (path) => {
    try {
      if (path === handlers.currentId) throw new Error("Cannot delete the current session");
      await catalog.remove(catalog.referenceId(path));
      const view = selector as unknown as { refreshSessionsAfterMutation(): Promise<void> };
      await view.refreshSessionsAfterMutation();
      handlers.render();
    } catch (error) {
      list.onError?.(error instanceof Error ? error.message : String(error));
    }
  };
  return selector;
}

export async function pickSession(
  catalog: SessionCatalog,
  cwd: string,
  agentDir: string,
): Promise<string | undefined> {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  initTheme(settings.getTheme());
  const keybindings = KeybindingsManager.create(agentDir);
  setKeybindings(keybindings);
  const ui = new TuiMainScreen(new ProcessTerminal(), settings.getShowHardwareCursor(), agentDir);
  ui.setClearOnShrink(settings.getClearOnShrink());
  try {
    return await new Promise((resolve) => {
      const selector = createSelector(catalog, cwd, {
        select: resolve,
        cancel: () => resolve(undefined),
        exit: () => resolve(undefined),
        render: () => ui.requestRender(),
        keybindings,
        showRenameHint: false,
      });
      ui.addChild(selector);
      ui.setFocus(selector);
      ui.start();
    });
  } finally {
    ui.stop();
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  }
}

interface PickerHost {
  showSessionSelector(): void;
  showSelector(
    factory: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
  ): void;
  showStatus(message: string): void;
  showError(message: string): void;
  shutdown(): Promise<void>;
  readonly ui: { requestRender(): void };
  readonly keybindings: SelectorOptions["keybindings"];
}

export function bindSessionPicker(
  interactive: InteractiveMode,
  catalog: SessionCatalog,
  runtime: {
    readonly current: () => { readonly id: string; readonly cwd: string };
    readonly select: (id: string) => Promise<{ cancelled: boolean }>;
    readonly rename: (id: string, name: string) => void | Promise<void>;
  },
): void {
  // Pi 1.6.1 exposes the widget and keeps the editor slot behind a host method.
  const host = interactive as unknown as PickerHost;
  host.showSessionSelector = () => {
    const current = runtime.current();
    host.showSelector((done) => {
      const selector = createSelector(catalog, current.cwd, {
        currentId: catalog.reference(current.id),
        keybindings: host.keybindings,
        select(id) {
          done();
          void runtime.select(id).then(
            ({ cancelled }) => {
              if (!cancelled) host.showStatus("Resumed session");
            },
            (error: unknown) =>
              host.showError(error instanceof Error ? error.message : String(error)),
          );
        },
        cancel() {
          done();
          host.ui.requestRender();
        },
        exit: () => {
          void host.shutdown();
        },
        render: () => host.ui.requestRender(),
        async rename(path, name) {
          const value = name?.trim();
          if (value) await runtime.rename(catalog.referenceId(path), value);
        },
      });
      return { component: selector, focus: selector };
    });
  };
}
