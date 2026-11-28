import {
  CancellationTokenSource,
  EventEmitter,
  FileSystemError,
  Uri,
  WorkspaceEdit,
  type WorkspaceEditEntry,
} from "@harness/vscode-types";
import { findWorkspaceRoot } from "../workspace-root.ts";
import type { ExtHostBridge } from "./bridge.ts";
import type { createFileSystemApi } from "./file-system.ts";
import type { createNotebookApi } from "./notebooks.ts";

type Files = { files: readonly Uri[] };
type Renames = { files: readonly { oldUri: Uri; newUri: Uri }[] };
type Will<T> = T & {
  token: CancellationTokenSource["token"];
  waitUntil(edit: PromiseLike<WorkspaceEdit | undefined> | WorkspaceEdit | undefined): void;
};

export function createFileOperations(
  bridge: ExtHostBridge,
  fs: ReturnType<typeof createFileSystemApi>["fs"],
  notebooks?: Pick<
    ReturnType<typeof createNotebookApi>,
    "applyNotebookEdit" | "applyCellTextEdits"
  >,
) {
  const create = new EventEmitter<Files>();
  const rename = new EventEmitter<Renames>();
  const remove = new EventEmitter<Files>();
  const willCreate = new EventEmitter<Will<Files>>();
  const willRename = new EventEmitter<Will<Renames>>();
  const willRemove = new EventEmitter<Will<Files>>();
  for (const [name, emitter] of [
    ["Create", create],
    ["Delete", remove],
  ] as const) {
    bridge.commandHandlers.set(`__ws.onDid${name}Files`, (raw) =>
      emitter.fire({ files: (raw as Files).files.map((uri) => Uri.revive(uri)) }),
    );
  }
  bridge.commandHandlers.set("__ws.onDidRenameFiles", (raw) =>
    rename.fire({
      files: (raw as Renames).files.map((file) => ({
        oldUri: Uri.revive(file.oldUri),
        newUri: Uri.revive(file.newUri),
      })),
    }),
  );
  const exists = async (uri: Uri) => {
    try {
      await fs.stat(uri);
      return true;
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "FileNotFound") return false;
      throw error;
    }
  };
  async function before<T extends Files | Renames>(
    emitter: EventEmitter<Will<T>>,
    event: T,
  ): Promise<boolean> {
    const cancellation = new CancellationTokenSource();
    const pending: PromiseLike<WorkspaceEdit | undefined>[] = [];
    let accepting = true;
    try {
      emitter.fire({
        ...event,
        token: cancellation.token,
        waitUntil(value) {
          if (!accepting)
            throw new Error("waitUntil must be called during the file operation event");
          pending.push(Promise.resolve(value));
        },
      });
      accepting = false;
      for (const edit of await Promise.all(pending))
        if (edit && !(await applyEdit(edit))) return false;
      return true;
    } finally {
      cancellation.dispose();
    }
  }
  async function applyEdit(edit?: WorkspaceEdit): Promise<boolean> {
    if (!edit?.entries) return false;
    const entries = edit._allEntries?.();
    if (entries?.some((entry) => entry.type === "snippet" || entry.metadata?.needsConfirmation))
      return false;
    const applyText = async (value: Pick<WorkspaceEdit, "entries">) => {
      const edits = [];
      for (const [uri, items] of value.entries()) {
        const applied = notebooks?.applyCellTextEdits(uri, items);
        if (applied === false) return false;
        if (applied === undefined)
          edits.push([
            uri.toJSON(),
            items.map((item) => ({
              start: item.range.start,
              end: item.range.end,
              newText: item.newText,
            })),
          ]);
      }
      if (!edits.length) return true;
      return Boolean(await bridge.callMain("workspace.applyEdit", edits));
    };
    if (!entries || entries.every((entry) => entry.type === "text")) return applyText(edit);
    let text = new WorkspaceEdit();
    const flushText = async () => {
      if (!text.size) return true;
      const applied = await applyText(text);
      text = new WorkspaceEdit();
      return applied;
    };
    try {
      for (const entry of entries as readonly Exclude<WorkspaceEditEntry, { type: "snippet" }>[]) {
        if (entry.type === "text") {
          text.set(entry.uri, [entry.edit]);
          continue;
        }
        if (!(await flushText())) return false;
        if (entry.type === "notebook") {
          if (!notebooks?.applyNotebookEdit(entry.uri, entry.edit)) return false;
        } else if (entry.type === "create") {
          if ((await exists(entry.uri)) && !entry.options?.overwrite) {
            if (entry.options?.ignoreIfExists) continue;
            return false;
          }
          const event = { files: [entry.uri] };
          if (!(await before(willCreate, event))) return false;
          await fs.writeFile(entry.uri, entry.options?.contents ?? new Uint8Array());
          create.fire(event);
        } else if (entry.type === "delete") {
          if (!(await exists(entry.uri)) && entry.options?.ignoreIfNotExists) continue;
          const event = { files: [entry.uri] };
          if (!(await before(willRemove, event))) return false;
          await fs.delete(entry.uri, { recursive: entry.options?.recursive });
          remove.fire(event);
        } else if (entry.type === "rename") {
          if ((await exists(entry.target)) && !entry.options?.overwrite) {
            if (entry.options?.ignoreIfExists) continue;
            return false;
          }
          const event = { files: [{ oldUri: entry.uri, newUri: entry.target }] };
          if (!(await before(willRename, event))) return false;
          const roots = bridge.getWorkspaceRoots();
          const root =
            entry.uri.scheme === "file" ? findWorkspaceRoot(roots, entry.uri.fsPath) : undefined;
          if (
            root !== undefined &&
            entry.target.scheme === "file" &&
            findWorkspaceRoot(roots, entry.target.fsPath) === root
          ) {
            await bridge.callMain("workspace.rename", entry.uri.toJSON(), entry.target.toJSON(), {
              overwrite: entry.options?.overwrite,
            });
          } else {
            await fs.rename(entry.uri, entry.target, { overwrite: entry.options?.overwrite });
          }
          rename.fire(event);
        }
      }
      return await flushText();
    } catch {
      return false;
    }
  }
  return {
    applyEdit,
    onWillCreateFiles: willCreate.event,
    onDidCreateFiles: create.event,
    onWillDeleteFiles: willRemove.event,
    onDidDeleteFiles: remove.event,
    onWillRenameFiles: willRename.event,
    onDidRenameFiles: rename.event,
  };
}
