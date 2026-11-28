import { TerminalExitReason } from "@harness/vscode-types";
import type { UiCommandsService } from "@harness/ui-commands";
import { effectScope, type EffectScope } from "vue";
import type { UiTerminalService } from "@harness/ui-terminal";
import { TERMINAL_LAUNCH_ERROR_NAME } from "../wire-error.ts";

export function createMainThreadTerminal(
  terminal: UiTerminalService,
  commands: Pick<UiCommandsService, "useCommand">,
  executeCommand: (sessionId: string, command: string, args: unknown[]) => Promise<unknown>,
) {
  const idMap = new Map<string, string>();
  const quickFixScopes = new Map<string, EffectScope>();
  const linkScopes = new Map<string, EffectScope>();
  const streams = new Map<string, { dispose(): void }>();
  const disposing = new Set<string>();

  const closeTerminal = async (
    sessionId: string,
    extId: string,
    reason: TerminalExitReason,
    code?: number,
  ) => {
    if (!idMap.delete(extId)) return;
    const stream = streams.get(extId);
    streams.delete(extId);
    stream?.dispose();
    await executeCommand(sessionId, `__term.closed.${extId}`, [reason, code]);
  };

  const handle = async (sessionId: string, method: string, args: unknown[]): Promise<boolean> => {
    if (method === "terminal.create") {
      const [extId, opts] = args as [
        string,
        (
          | {
              name?: string;
              cwd?: string;
              env?: Record<string, string | null>;
              shell?: string;
              args?: string[];
            }
          | undefined
        ),
      ];
      const created = await terminal.create({
        title: opts?.name,
        cwd: opts?.cwd,
        env: opts?.env,
        shell: opts?.shell,
        args: opts?.args,
      });
      if (created) {
        idMap.set(extId, created.id);
        const opening = executeCommand(sessionId, `__term.opened.${extId}`, [created.pid]);
        const stream = terminal.observe?.(created.id, {
          onStateChange: (state) => {
            void executeCommand(sessionId, `__term.state.${extId}`, [state]);
          },
          onData: (data) => {
            void executeCommand(sessionId, `__term.data.${extId}`, [data]);
          },
          onExit: (code) => {
            void closeTerminal(sessionId, extId, TerminalExitReason.Process, code).catch(
              console.error,
            );
          },
          onClose: () => {
            const reason = disposing.has(extId)
              ? TerminalExitReason.Extension
              : TerminalExitReason.User;
            void closeTerminal(sessionId, extId, reason).catch(console.error);
          },
        });
        if (stream) {
          if (idMap.has(extId)) streams.set(extId, stream);
          else stream.dispose();
        }
        await opening;
      } else {
        const error = new Error("Terminal creation failed");
        error.name = TERMINAL_LAUNCH_ERROR_NAME;
        throw error;
      }
      return true;
    }
    if (method === "terminal.select") {
      const [extId] = args as [string];
      const realId = idMap.get(extId);
      if (realId) {
        terminal.select(realId);
        await executeCommand(sessionId, "__term.active", [extId]);
      }
      return true;
    }
    if (method === "terminal.kill") {
      const [extId] = args as [string];
      const realId = idMap.get(extId);
      if (realId) {
        if (disposing.has(extId)) return true;
        disposing.add(extId);
        try {
          await terminal.kill(realId);
          await closeTerminal(sessionId, extId, TerminalExitReason.Extension);
        } finally {
          disposing.delete(extId);
        }
      }
      return true;
    }
    if (method === "terminal.sendText") {
      const [extId, text] = args as [string, string];
      const realId = idMap.get(extId);
      if (realId) {
        await terminal.write(realId, text);
      }
      return true;
    }
    if (method === "terminal.registerQuickFixProvider") {
      const [id] = args as [string];
      if (!quickFixScopes.has(id)) {
        const scope = effectScope();
        scope.run(() =>
          commands.useCommand(
            `terminal.quickFix:${id}`,
            () => executeCommand(sessionId, `__term.quickFix.${id}`, []),
            { title: `Terminal: Quick Fix (${id})` },
          ),
        );
        quickFixScopes.set(id, scope);
      }
      return true;
    }
    if (method === "terminal.unregisterQuickFixProvider") {
      const [id] = args as [string];
      quickFixScopes.get(id)?.stop();
      quickFixScopes.delete(id);
      return true;
    }
    if (method === "terminal.registerLinkProvider") {
      const [id] = args as [string];
      linkScopes.get(id)?.stop();
      const scope = effectScope();
      scope.run(() =>
        commands.useCommand(
          `terminal.provideLinks:${id}`,
          (line: unknown) => executeCommand(sessionId, `__term.provideLinks.${id}`, [line]),
          { title: `Terminal: Provide Links (${id})` },
        ),
      );
      linkScopes.set(id, scope);
      return true;
    }
    if (method === "terminal.unregisterLinkProvider") {
      const [id] = args as [string];
      linkScopes.get(id)?.stop();
      linkScopes.delete(id);
      return true;
    }
    return false;
  };
  const reset = async () => {
    const terminals = [...idMap.values()];
    idMap.clear();
    for (const stream of streams.values()) stream.dispose();
    streams.clear();
    for (const scope of [...linkScopes.values(), ...quickFixScopes.values()]) scope.stop();
    linkScopes.clear();
    quickFixScopes.clear();
    await Promise.all(terminals.map((id) => terminal.kill(id).catch(() => undefined)));
  };
  return Object.assign(handle, {
    reset,
    dispose() {
      void reset();
    },
  });
}
