import { ContextKeyExpr } from "monaco-editor/esm/vs/platform/contextkey/common/contextkey.js";
import { Range, Uri } from "@harness/vscode-types";
import type { VscodeWindowCompatService } from "@harness/vscode-editor-compat";
import { shallowReactive, watch } from "vue";
import type { CommentControllerData, CommentThreadData } from "../comments-types.ts";

type ControllerState = CommentControllerData & { key: string; sessionId: string };
export type CommentThreadState = CommentThreadData & {
  key: string;
  sessionId: string;
  focusRevision: number;
  focusedComment?: number;
  focus?: number;
};
export interface CommentAction {
  command: string;
  title: string;
  group?: string;
  enabled: boolean;
}

export function createMainThreadComments(
  window: Pick<
    VscodeWindowCompatService,
    "visibleTextEditors" | "createTextEditorDecorationType" | "showTextDocument"
  >,
  execute: (sessionId: string, command: string, args: unknown[]) => Promise<unknown>,
  showPanel: () => void,
  contexts: ReadonlyMap<string, unknown>,
  isVisible: () => boolean = () => true,
) {
  const controllers = shallowReactive(new Map<string, ControllerState>());
  const threads = shallowReactive(new Map<string, CommentThreadState>());
  const decoration = window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    borderColor: { id: "editorCommentsWidget.unresolvedBorder" },
    backgroundColor: { id: "editor.rangeHighlightBackground" },
  });
  const keyFor = (sessionId: string, handle: number) => JSON.stringify([sessionId, handle]);
  const rangeOf = (thread: CommentThreadData) =>
    thread.range
      ? new Range(
          thread.range.start.line,
          thread.range.start.character,
          thread.range.end.line,
          thread.range.end.character,
        )
      : new Range(0, 0, 0, 0);
  let focusRevision = 0;
  const stop = watch(
    () => [isVisible(), [...threads.values()], window.visibleTextEditors.value],
    () => {
      for (const editor of window.visibleTextEditors.value)
        editor.setDecorations(
          decoration,
          (isVisible() ? [...threads.values()] : [])
            .filter((thread) => Uri.from(thread.uri).toString() === editor.document.uri.toString())
            .map((thread) => ({
              range: rangeOf(thread),
              hoverMessage: thread.comments.map((comment) => ({
                value: `**${comment.author.name}**\n\n${typeof comment.body === "string" ? comment.body : comment.body.value}`,
                isTrusted: false,
              })),
            })),
        );
    },
    { immediate: true },
  );
  const controllerFor = (thread: CommentThreadState) =>
    controllers.get(keyFor(thread.sessionId, thread.controller));
  const matches = (
    condition: string | undefined,
    thread: CommentThreadState,
    commentId?: number,
    text = "",
  ) => {
    if (!condition) return true;
    const expression = ContextKeyExpr.deserialize(condition);
    if (!expression) throw new Error(`Invalid comment menu condition: ${condition}`);
    const comment = thread.comments.find((item) => item.id === commentId);
    const local: Record<string, unknown> = {
      commentController: controllerFor(thread)?.id,
      commentThread: thread.contextValue,
      comment: comment?.contextValue,
      commentIsEmpty: text.length === 0,
    };
    return expression.evaluate({
      getValue: <T>(key: string) => (key in local ? local[key] : contexts.get(key)) as T,
    });
  };
  const adapter = {
    controllers,
    threads,
    controllerFor,
    actions(
      thread: CommentThreadState,
      location: string,
      commentId?: number,
      text?: string,
    ): CommentAction[] {
      const contributions = controllerFor(thread)?.contributions;
      if (!contributions) return [];
      const result: CommentAction[] = [];
      const visit = (menu: string, seen = new Set<string>()) => {
        if (seen.has(menu)) throw new Error(`Recursive comment submenu: ${menu}`);
        const nextSeen = new Set([...seen, menu]);
        for (const item of contributions.menus?.[menu] ?? []) {
          if (!matches(item.when, thread, commentId, text)) continue;
          if (item.submenu) {
            visit(item.submenu, nextSeen);
            continue;
          }
          const command = contributions.commands?.find(
            (candidate) => candidate.command === item.command,
          );
          if (!command) continue;
          result.push({
            command: command.command,
            title: typeof command.title === "string" ? command.title : command.title.value,
            group: item.group,
            enabled: matches(command.enablement, thread, commentId, text),
          });
        }
      };
      visit(location);
      return result.sort((a, b) => (a.group ?? "").localeCompare(b.group ?? ""));
    },
    async activate(key: string, commentId?: number): Promise<void> {
      const thread = threads.get(key);
      if (thread)
        await execute(thread.sessionId, "__comments.setActive", [thread.handle, commentId]);
    },
    async invoke(key: string, command: string, commentId?: number, text?: string): Promise<void> {
      const thread = threads.get(key);
      if (!thread) throw new Error("Comment thread was removed");
      await adapter.activate(key, commentId);
      await execute(thread.sessionId, "__comments.execute", [
        { threadHandle: thread.handle, commentHandle: commentId, command, text },
      ]);
    },
    async reveal(key: string, commentId?: number, focus?: number): Promise<void> {
      const thread = threads.get(key);
      if (!thread) throw new Error("Comment thread was removed");
      const editor = await window.showTextDocument(Uri.from(thread.uri), {
        preserveFocus: focus === undefined,
        selection: rangeOf(thread),
      });
      editor.revealRange(rangeOf(thread));
      showPanel();
      threads.set(key, {
        ...thread,
        collapsibleState: 1,
        focusRevision: ++focusRevision,
        focusedComment: commentId,
        focus,
      });
      await adapter.activate(key, commentId);
    },
    async toggle(key: string): Promise<void> {
      const thread = threads.get(key);
      if (thread)
        await execute(thread.sessionId, "__comments.setCollapsed", [
          thread.handle,
          thread.collapsibleState === 1 ? 0 : 1,
        ]);
    },
    async handle(sessionId: string, method: string, args: unknown[]): Promise<boolean> {
      if (method === "comments.register") {
        const data = args[0] as CommentControllerData;
        const key = keyFor(sessionId, data.handle);
        controllers.set(key, { ...data, key, sessionId });
      } else if (method === "comments.updateController") {
        const data = args[0] as { handle: number; options: CommentControllerData["options"] };
        const key = keyFor(sessionId, data.handle),
          owner = controllers.get(key);
        if (owner) controllers.set(key, { ...owner, options: data.options });
      } else if (method === "comments.setThread") {
        const data = args[0] as CommentThreadData;
        const key = keyFor(sessionId, data.handle),
          previous = threads.get(key);
        if (!controllers.has(keyFor(sessionId, data.controller)))
          throw new Error("Unknown comment controller");
        threads.set(key, {
          ...previous,
          ...data,
          key,
          sessionId,
          focusRevision: previous?.focusRevision ?? 0,
        });
      } else if (method === "comments.removeThread")
        threads.delete(keyFor(sessionId, args[0] as number));
      else if (method === "comments.unregister") {
        const handle = args[0] as number;
        controllers.delete(keyFor(sessionId, handle));
        for (const [key, thread] of threads)
          if (thread.sessionId === sessionId && thread.controller === handle) threads.delete(key);
      } else if (method === "comments.reveal") {
        const data = args[0] as { threadHandle: number; commentHandle?: number; focus?: number };
        await adapter.reveal(keyFor(sessionId, data.threadHandle), data.commentHandle, data.focus);
      } else return false;
      return true;
    },
    clearSession(sessionId: string): void {
      for (const [key, value] of threads) if (value.sessionId === sessionId) threads.delete(key);
      for (const [key, value] of controllers)
        if (value.sessionId === sessionId) controllers.delete(key);
    },
    dispose(): void {
      stop();
      decoration.dispose();
      threads.clear();
      controllers.clear();
    },
  };
  return adapter;
}
