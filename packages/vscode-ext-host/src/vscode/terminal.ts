import { TerminalExitReason } from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";
import { CancellationTokenSource, Disposable, EventEmitter, Uri } from "./types.ts";
import { TERMINAL_LAUNCH_ERROR_NAME } from "../wire-error.ts";

let terminalCounter = 0;
type TerminalOptions = {
  name?: string;
  cwd?: string | Uri;
  env?: Record<string, string | null>;
  shellPath?: string;
  shellArgs?: string[];
};
type HostTerminal = {
  name: string;
  processId: Promise<number | undefined>;
  creationOptions: TerminalOptions;
  readonly exitStatus: { code?: number; reason: TerminalExitReason } | undefined;
  readonly state: { readonly isInteractedWith: boolean; shell?: string };
  sendText(text: string, addNewLine?: boolean): void;
  show(): void;
  dispose(): void;
};

export function createTerminalApi(bridge: ExtHostBridge) {
  const profileProviders = new Map<
    string,
    {
      provideTerminalProfile(
        token: CancellationTokenSource["token"],
      ):
        | { options: TerminalOptions }
        | undefined
        | PromiseLike<{ options: TerminalOptions } | undefined>;
    }
  >();
  const terminals = new Map<string, HostTerminal>();
  const opened = new EventEmitter<HostTerminal>(),
    closed = new EventEmitter<HostTerminal>(),
    activeChanged = new EventEmitter<HostTerminal | undefined>();
  const stateChanged = new EventEmitter<HostTerminal>();
  let active: HostTerminal | undefined;
  bridge.commandHandlers.set("__term.active", (id) => {
    active = terminals.get(String(id));
    activeChanged.fire(active);
  });
  const completionProviders = new Map<
    string,
    {
      provider: {
        provideTerminalCompletions(
          terminal: unknown,
          context: unknown,
          token: CancellationTokenSource["token"],
        ): unknown;
      };
      triggers: string[];
    }
  >();
  bridge.commandHandlers.set("__term.provideCompletions", async (raw) => {
    const request = raw as {
      terminal: {
        shellIntegration?: { cwd?: Parameters<typeof Uri.from>[0]; env?: unknown };
        [key: string]: unknown;
      };
      context: unknown;
    };
    const terminal = {
      ...request.terminal,
      shellIntegration: request.terminal.shellIntegration
        ? {
            ...request.terminal.shellIntegration,
            cwd: request.terminal.shellIntegration.cwd
              ? Uri.from(request.terminal.shellIntegration.cwd)
              : undefined,
          }
        : undefined,
    };
    const source = new CancellationTokenSource();
    try {
      return await Promise.all(
        [...completionProviders.values()].map((entry) =>
          entry.provider.provideTerminalCompletions(terminal, request.context, source.token),
        ),
      );
    } finally {
      source.dispose();
    }
  });
  const dataEmitter = new EventEmitter<{ terminal: unknown; data: string }>();
  const startExecEmitter = new EventEmitter<{
    terminal: unknown;
    execution: { commandLine: { value: string } };
  }>();
  const endExecEmitter = new EventEmitter<{ terminal: unknown; exitCode: number | undefined }>();

  bridge.commandHandlers.set("__term.createProfile", async (rawId) => {
    const id = String(rawId);
    await bridge.activateByEvent?.(`onTerminalProfile:${id}`);
    const provider = profileProviders.get(id);
    if (!provider) throw new Error(`No terminal profile provider: ${id}`);
    const cancellation = new CancellationTokenSource();
    try {
      const profile = await provider.provideTerminalProfile(cancellation.token);
      if (!profile) return undefined;
      if ("pty" in profile.options) throw new Error("Extension pseudoterminals are not supported");
      const terminal = api.createTerminal(profile.options);
      return { name: terminal.name, processId: await terminal.processId };
    } finally {
      cancellation.dispose();
    }
  });
  const api = {
    registerTerminalProfileProvider(
      id: string,
      provider: {
        provideTerminalProfile(
          token: CancellationTokenSource["token"],
        ):
          | { options: TerminalOptions }
          | undefined
          | PromiseLike<{ options: TerminalOptions } | undefined>;
      },
    ) {
      if (profileProviders.has(id))
        throw new Error(`Terminal profile provider already registered: ${id}`);
      profileProviders.set(id, provider);
      return new Disposable(() => {
        if (profileProviders.get(id) === provider) profileProviders.delete(id);
      });
    },
    get terminals() {
      return [...terminals.values()];
    },
    get activeTerminal() {
      return active;
    },
    onDidChangeTerminalState: stateChanged.event,
    onDidOpenTerminal: opened.event,
    onDidCloseTerminal: closed.event,
    onDidChangeActiveTerminal: activeChanged.event,
    registerTerminalCompletionProvider(
      provider: {
        provideTerminalCompletions(
          terminal: unknown,
          context: unknown,
          token: CancellationTokenSource["token"],
        ): unknown;
      },
      ...triggerCharacters: string[]
    ) {
      const id = `completion-${++terminalCounter}`;
      completionProviders.set(id, { provider, triggers: triggerCharacters });
      return new Disposable(() => {
        completionProviders.delete(id);
      });
    },
    onDidWriteTerminalData: dataEmitter.event,
    onDidStartTerminalShellExecution: startExecEmitter.event,
    onDidEndTerminalShellExecution: endExecEmitter.event,
    createTerminal(options?: TerminalOptions | string, shellPath?: string, shellArgs?: string[]) {
      const id = `ext-term-${++terminalCounter}`;
      const name = typeof options === "string" ? options : options?.name;
      const opts: TerminalOptions | undefined =
        typeof options === "string" ? { name, shellPath, shellArgs } : options;
      const cwd = typeof opts?.cwd === "string" ? opts.cwd : opts?.cwd?.fsPath;
      const env = bridge.getTerminalEnvironment?.(opts?.env, cwd) ?? opts?.env;
      const created = bridge
        .callMain("terminal.create", id, {
          name,
          cwd,
          env,
          shell: opts?.shellPath,
          args: opts?.shellArgs,
        })
        .catch(handleLaunchFailure);
      const processId = Promise.withResolvers<number | undefined>();
      let exitStatus: HostTerminal["exitStatus"];
      let state = {
        isInteractedWith: false,
        shell: (opts?.shellPath ?? process.env.SHELL)?.split("/").at(-1),
      };
      let disposed = false;
      function sendAfterLaunch(method: string, ...args: unknown[]) {
        void created
          .then(() => {
            if (terminals.has(id)) return bridge.callMain(method, id, ...args);
          })
          .catch(console.error);
      }
      const term: HostTerminal = {
        name: name ?? "Terminal",
        processId: processId.promise,
        creationOptions: opts ?? {},
        get exitStatus() {
          return exitStatus;
        },
        get state() {
          return state;
        },
        sendText(text: string, addNewLine = true) {
          sendAfterLaunch("terminal.sendText", addNewLine ? `${text}\n` : text);
        },
        show() {
          sendAfterLaunch("terminal.select");
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          sendAfterLaunch("terminal.kill");
        },
      };
      terminals.set(id, term);
      bridge.commandHandlers.set(`__term.opened.${id}`, (pid) => {
        processId.resolve(typeof pid === "number" ? pid : undefined);
        active = term;
        opened.fire(term);
        activeChanged.fire(active);
      });
      bridge.commandHandlers.set(`__term.closed.${id}`, (reason, code) => {
        if (!terminals.delete(id)) return;
        exitStatus = Object.freeze({
          code: typeof code === "number" ? code : undefined,
          reason: (reason as TerminalExitReason | undefined) ?? TerminalExitReason.Unknown,
        });
        processId.resolve(undefined);
        finishClose();
      });

      bridge.commandHandlers.set(`__term.state.${id}`, (value) => {
        const next = value as { isInteractedWith: boolean };
        if (next.isInteractedWith !== state.isInteractedWith) {
          state = { ...state, isInteractedWith: next.isInteractedWith };
          stateChanged.fire(term);
        }
      });
      bridge.commandHandlers.set(`__term.data.${id}`, (data: unknown) => {
        dataEmitter.fire({ terminal: term, data: String(data) });
      });
      bridge.commandHandlers.set(`__term.execStart.${id}`, (cmdLine: unknown) => {
        startExecEmitter.fire({
          terminal: term,
          execution: { commandLine: { value: String(cmdLine) } },
        });
      });
      bridge.commandHandlers.set(`__term.execEnd.${id}`, (exitCode: unknown) => {
        endExecEmitter.fire({
          terminal: term,
          exitCode: typeof exitCode === "number" ? exitCode : undefined,
        });
      });

      function handleLaunchFailure(error: unknown) {
        console.error(error);
        if (!terminals.has(id)) return;
        const rejectedLaunch = error instanceof Error && error.name === TERMINAL_LAUNCH_ERROR_NAME;
        if (rejectedLaunch) opened.fire(term);
        if (!terminals.delete(id)) return;
        exitStatus = Object.freeze({
          code: undefined,
          reason: rejectedLaunch ? TerminalExitReason.Process : TerminalExitReason.Unknown,
        });
        processId.resolve(undefined);
        finishClose();
      }

      function finishClose() {
        closed.fire(term);
        if (active === term) {
          active = [...terminals.values()].at(-1);
          activeChanged.fire(active);
        }
        for (const event of ["opened", "closed", "state", "data", "execStart", "execEnd"])
          bridge.commandHandlers.delete(`__term.${event}.${id}`);
      }

      return term;
    },
    registerTerminalQuickFixProvider(
      id: string,
      provider: { provideTerminalQuickFixes(terminalCommand: unknown): unknown },
    ) {
      const cmd = `__term.quickFix.${id}`;
      bridge.commandHandlers.set(cmd, (terminalCommand: unknown) =>
        provider.provideTerminalQuickFixes(terminalCommand),
      );
      void bridge.callMain("terminal.registerQuickFixProvider", id);
      return {
        dispose() {
          bridge.commandHandlers.delete(cmd);
          void bridge.callMain("terminal.unregisterQuickFixProvider", id);
        },
      };
    },
    registerTerminalLinkProvider(provider: {
      provideTerminalLinks(context: { line: string }): Promise<unknown[]> | unknown[];
      handleTerminalLink?(link: unknown): Promise<void> | void;
    }) {
      const id = `tl-${++terminalCounter}`;
      const provideCmd = `__term.provideLinks.${id}`;
      const handleCmd = `__term.handleLink.${id}`;
      bridge.commandHandlers.set(provideCmd, (line: unknown) =>
        provider.provideTerminalLinks({ line: String(line ?? "") }),
      );
      bridge.commandHandlers.set(handleCmd, (link: unknown) => provider.handleTerminalLink?.(link));
      void bridge.callMain("terminal.registerLinkProvider", id);
      return {
        dispose() {
          bridge.commandHandlers.delete(provideCmd);
          bridge.commandHandlers.delete(handleCmd);
          void bridge.callMain("terminal.unregisterLinkProvider", id);
        },
      };
    },
  };
  return api;
}
