import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  hasTrustRequiringProjectResources,
  initTheme,
  ProjectTrustStore,
  type DefaultResourceLoader,
  type ProjectTrustContext,
  type ProjectTrustHandler,
  type ProjectTrustUpdate,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  setCapabilityOverrides,
  TuiMainScreen,
  type ProgramStatus,
} from "@earendil-works/pi-tui";

type ReloadOptions = NonNullable<Parameters<DefaultResourceLoader["reload"]>[0]>;
type ProjectTrustMode = ProjectTrustContext["mode"];

function startupUi(settings: SettingsManager, agentDir: string): ProjectTrustContext["ui"] {
  async function dialog(
    title: string,
    kind: NonNullable<ProgramStatus["kind"]>,
    build: (
      ui: TuiMainScreen,
      select: (value?: string) => void,
    ) => ExtensionSelectorComponent | ExtensionInputComponent,
  ): Promise<string | undefined> {
    setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
    initTheme(settings.getTheme());
    const terminal = new ProcessTerminal();
    const ui = new TuiMainScreen(terminal, settings.getShowHardwareCursor(), agentDir);
    ui.setClearOnShrink(settings.getClearOnShrink());
    const selected = Promise.withResolvers<string | undefined>();
    const component = build(ui, selected.resolve);
    try {
      ui.addChild(component);
      ui.setFocus(component);
      terminal.setProgramStatus({
        state: "blocked",
        app: "pi",
        kind,
        message: title.split("\n", 1)[0],
      });
      ui.start();
      return await selected.promise;
    } finally {
      component.dispose();
      ui.clear();
      ui.requestRender();
      await setTimeout(25);
      ui.stop();
      await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    }
  }

  const select: ProjectTrustContext["ui"]["select"] = (title, choices, options) =>
    dialog(
      title,
      options?.blockedKind ?? "question",
      (ui, finish) =>
        new ExtensionSelectorComponent(title, choices, finish, () => finish(), { tui: ui }),
    );
  return {
    select,
    async confirm(title, message, options) {
      return (
        (await select(`${title}\n${message}`, ["Yes", "No"], {
          blockedKind: "permission",
          ...options,
        })) === "Yes"
      );
    },
    input(title, placeholder, options) {
      return dialog(
        title,
        options?.blockedKind ?? "question",
        (ui, finish) =>
          new ExtensionInputComponent(title, placeholder, finish, () => finish(), { tui: ui }),
      );
    },
    notify: () => {},
  };
}

function choicesFor(path: string) {
  const parent = dirname(path);
  const choices: { label: string; trusted: boolean; updates: ProjectTrustUpdate[] }[] = [
    { label: "Trust", trusted: true, updates: [{ path, decision: true }] },
  ];
  if (parent !== path) {
    choices.push({
      label: `Trust parent folder (${parent})`,
      trusted: true,
      updates: [
        { path: parent, decision: true },
        { path, decision: null },
      ],
    });
  }
  choices.push(
    { label: "Trust (this session only)", trusted: true, updates: [] },
    { label: "Do not trust", trusted: false, updates: [{ path, decision: false }] },
    { label: "Do not trust (this session only)", trusted: false, updates: [] },
  );
  return choices;
}

export function createProjectTrustResolver(
  agentDir: string,
  mode: ProjectTrustMode,
  override?: boolean,
) {
  const store = new ProjectTrustStore(agentDir);
  const decisions = new Map<string, boolean>();
  return (
    cwd: string,
    settings: SettingsManager,
    startup: boolean,
    interactive?: ProjectTrustContext,
  ): ReloadOptions | undefined => {
    const path = realpathSync(cwd);
    const known = override ?? decisions.get(path);
    if (known !== undefined || !hasTrustRequiringProjectResources(cwd)) {
      settings.setProjectTrusted(known ?? store.get(path) ?? true);
      return undefined;
    }

    const hasUI = startup && mode === "tui";
    const context: ProjectTrustContext = interactive ?? {
      cwd,
      mode,
      hasUI,
      ui: hasUI
        ? startupUi(settings, agentDir)
        : {
            select: async () => undefined,
            confirm: async () => false,
            input: async () => undefined,
            notify: (message) => console.error(message),
          },
    };
    return {
      async resolveProjectTrust({ extensionsResult }) {
        function remember(trusted: boolean): boolean {
          decisions.set(path, trusted);
          return trusted;
        }
        for (const extension of extensionsResult.extensions) {
          for (const handler of extension.handlers.get("project_trust") ?? []) {
            try {
              const result = await (handler as ProjectTrustHandler)(
                { type: "project_trust", cwd },
                context,
              );
              if (result?.trusted !== "yes" && result?.trusted !== "no") continue;
              const trusted = result.trusted === "yes";
              if (result.remember) store.set(path, trusted);
              return remember(trusted);
            } catch (error) {
              console.error(
                `Extension "${extension.path}" project_trust error: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
        const saved = store.get(path);
        if (saved !== null) return remember(saved);
        const policy = settings.getDefaultProjectTrust();
        if (policy !== "ask") return remember(policy === "always");
        if (!context.hasUI) return remember(false);

        const choices = choicesFor(path);
        const label = await context.ui.select(
          `Trust project folder?\n${cwd}\n\nThis allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.`,
          choices.map((choice) => choice.label),
          { blockedKind: "permission" },
        );
        const selection = choices.find((choice) => choice.label === label);
        if (selection?.updates.length) store.setMany(selection.updates);
        return remember(selection?.trusted ?? false);
      },
    };
  };
}

export type ProjectTrustResolver = ReturnType<typeof createProjectTrustResolver>;
