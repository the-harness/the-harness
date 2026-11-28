import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommentsContributions, CommentThreadData } from "../comments-types.ts";
import type { ExtHostBridge } from "./bridge.ts";
import { Range, Uri, type MarkdownString } from "./types.ts";

type Comment = {
  body: string | MarkdownString;
  author: { name: string; iconPath?: Uri };
  mode: number;
  contextValue?: string;
  label?: string;
};
type CommentOptions = { prompt?: string; placeHolder?: string };
type Thread = {
  readonly uri: Uri;
  range: Range | undefined;
  comments: readonly Comment[];
  collapsibleState: number;
  canReply: boolean | { name: string };
  contextValue?: string;
  label?: string;
  state?: number;
  dispose(): void;
  reveal(comment?: Comment, options?: { focus?: number }): Promise<void>;
  hide(): Promise<void>;
};
type Controller = {
  readonly id: string;
  readonly label: string;
  readonly activeCommentThread: Thread | undefined;
  readonly activeComment: Comment | undefined;
  options?: CommentOptions;
  commentingRangeProvider: unknown;
  reactionHandler: unknown;
  createCommentThread(uri: Uri, range: Range | undefined, comments: readonly Comment[]): Thread;
  dispose(): void;
};

export function createCommentsNamespace(
  bridge: ExtHostBridge,
  getContributions: () => CommentsContributions | undefined,
) {
  let nextController = 0,
    nextThread = 0;
  const outstanding = new Set<Promise<unknown>>();
  const observe = (task: Promise<unknown>) => {
    outstanding.add(task);
    void task.then(
      () => outstanding.delete(task),
      (error) => {
        outstanding.delete(task);
        console.error(error);
      },
    );
  };
  const controllers = new Map<
    number,
    { controller: Controller; threads: Set<number>; activeThread?: Thread; activeComment?: Comment }
  >();
  const threads = new Map<
    number,
    {
      thread: Thread;
      controller: number;
      comments: Map<number, Comment>;
      pending(): Promise<unknown>;
    }
  >();
  bridge.commandHandlers.set("__comments.dispose", async () => {
    for (const owner of [...controllers.values()]) owner.controller.dispose();
    await Promise.all(outstanding);
  });
  bridge.commandHandlers.set("__comments.setActive", (threadHandle, commentHandle) => {
    for (const value of controllers.values()) {
      value.activeThread = undefined;
      value.activeComment = undefined;
    }
    const item = threads.get(threadHandle as number);
    const owner = item && controllers.get(item.controller);
    if (owner) {
      owner.activeThread = item!.thread;
      owner.activeComment = item!.comments.get(commentHandle as number);
    }
  });
  bridge.commandHandlers.set("__comments.setCollapsed", (threadHandle, state) => {
    const item = threads.get(threadHandle as number);
    if (!item) throw new Error("Comment thread was disposed");
    item.thread.collapsibleState = state as number;
    return item.pending();
  });
  bridge.commandHandlers.set("__comments.execute", async (raw) => {
    const { threadHandle, commentHandle, command, text } = raw as {
      threadHandle: number;
      commentHandle?: number;
      command: string;
      text?: string;
    };
    const item = threads.get(threadHandle);
    if (!item) throw new Error("Comment thread was disposed");
    if (!bridge.commandHandlers.has(command))
      await bridge.activateByEvent?.(`onCommand:${command}`);
    const callback = bridge.commandHandlers.get(command);
    if (!callback) throw new Error(`Comment command is unavailable: ${command}`);
    const argument =
      text !== undefined
        ? { thread: item.thread, text }
        : commentHandle === undefined
          ? item.thread
          : item.comments.get(commentHandle);
    if (argument === undefined) throw new Error("Comment was removed");
    return callback(argument);
  });
  return {
    createCommentController(id: string, label: string): Controller {
      if (!id || !label) throw new TypeError("Comment controller id and label are required");
      const handle = ++nextController;
      let disposed = false,
        options: CommentOptions | undefined;
      const declared = getContributions() ?? {};
      const extensionPath = bridge.getExtensionPath?.();
      const translationsPath = extensionPath && join(extensionPath, "package.nls.json");
      const translations =
        translationsPath && existsSync(translationsPath)
          ? (JSON.parse(readFileSync(translationsPath, "utf8")) as Record<
              string,
              string | { message: string }
            >)
          : {};
      const contributions = {
        ...declared,
        commands: declared.commands?.map((command) => {
          const title = typeof command.title === "string" ? command.title : command.title.value;
          const localized = /^%(.+)%$/.exec(title);
          const entry = localized && translations[localized[1]!];
          return {
            ...command,
            title:
              typeof entry === "string"
                ? entry
                : entry && typeof entry === "object"
                  ? entry.message
                  : title,
          };
        }),
      };
      let pending = bridge.callMain("comments.register", { handle, id, label, contributions });
      const publish = () => {
        pending = pending.then(() =>
          bridge.callMain("comments.updateController", { handle, options }),
        );
        observe(pending);
      };
      const controller: Controller = {
        id,
        label,
        get activeCommentThread() {
          return owner.activeThread;
        },
        get activeComment() {
          return owner.activeComment;
        },
        get options() {
          return options;
        },
        set options(value) {
          options = value;
          publish();
        },
        get commentingRangeProvider() {
          return undefined;
        },
        set commentingRangeProvider(value) {
          if (value !== undefined)
            throw new Error("Commenting range creation has no Harness editor consumer");
        },
        get reactionHandler() {
          return undefined;
        },
        set reactionHandler(value) {
          if (value !== undefined) throw new Error("Comment reactions have no Harness consumer");
        },
        createCommentThread(uri, range, comments) {
          if (disposed) throw new Error("Comment controller was disposed");
          const threadHandle = ++nextThread;
          let removed = false,
            nextComment = 0;
          const identities = new WeakMap<Comment, number>();
          const commentObjects = new Map<number, Comment>();
          const values = {
            range,
            comments,
            collapsibleState: 0,
            canReply: true as Thread["canReply"],
            contextValue: undefined as string | undefined,
            label: undefined as string | undefined,
            state: undefined as number | undefined,
          };
          const snapshot = (): CommentThreadData => {
            commentObjects.clear();
            if (values.comments.some((comment) => comment.mode === 0))
              throw new Error("Comment editing has no Harness consumer");
            return {
              handle: threadHandle,
              controller: handle,
              uri: uri.toJSON(),
              ...values,
              comments: values.comments.map((comment) => {
                let commentId = identities.get(comment);
                if (commentId === undefined) {
                  commentId = ++nextComment;
                  identities.set(comment, commentId);
                }
                commentObjects.set(commentId, comment);
                return {
                  id: commentId,
                  body:
                    typeof comment.body === "string" ? comment.body : { value: comment.body.value },
                  author: {
                    name: comment.author.name,
                    iconPath: comment.author.iconPath?.toJSON(),
                  },
                  mode: comment.mode,
                  contextValue: comment.contextValue,
                  label: comment.label,
                };
              }),
            };
          };
          const initial = snapshot();
          let threadPending = pending.then(() => bridge.callMain("comments.setThread", initial));
          const publishThread = () => {
            if (removed) throw new Error("Comment thread was disposed");
            const data = snapshot();
            threadPending = threadPending.then(() => bridge.callMain("comments.setThread", data));
            observe(threadPending);
          };
          const thread = {
            uri,
            dispose() {
              if (removed) return;
              removed = true;
              owner.threads.delete(threadHandle);
              threads.delete(threadHandle);
              if (owner.activeThread === thread) {
                owner.activeThread = undefined;
                owner.activeComment = undefined;
              }
              threadPending = threadPending.then(() =>
                bridge.callMain("comments.removeThread", threadHandle),
              );
              observe(threadPending);
            },
            async reveal(comment?: Comment, revealOptions?: { focus?: number }) {
              if (removed) throw new Error("Comment thread was disposed");
              const commentHandle = comment && identities.get(comment);
              if (comment && commentHandle === undefined)
                throw new Error("Comment does not belong to this thread");
              await threadPending;
              await bridge.callMain("comments.reveal", {
                threadHandle,
                commentHandle,
                focus: revealOptions?.focus,
              });
            },
            async hide() {
              thread.collapsibleState = 0;
              await threadPending;
            },
          } as Thread;
          for (const key of Object.keys(values) as (keyof typeof values)[])
            Object.defineProperty(thread, key, {
              enumerable: true,
              get: () => values[key],
              set: (value) => {
                Object.assign(values, { [key]: value });
                publishThread();
              },
            });
          owner.threads.add(threadHandle);
          threads.set(threadHandle, {
            thread,
            controller: handle,
            comments: commentObjects,
            pending: () => threadPending,
          });
          observe(threadPending);
          return thread;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          const active = [...owner.threads].map((threadHandle) => threads.get(threadHandle)!);
          for (const entry of active) entry.thread.dispose();
          controllers.delete(handle);
          pending = Promise.all([pending, ...active.map((entry) => entry.pending())]).then(() =>
            bridge.callMain("comments.unregister", handle),
          );
          observe(pending);
        },
      };
      const owner = {
        controller,
        threads: new Set<number>(),
        activeThread: undefined as Thread | undefined,
        activeComment: undefined as Comment | undefined,
      };
      controllers.set(handle, owner);
      observe(pending);
      return controller;
    },
  };
}
