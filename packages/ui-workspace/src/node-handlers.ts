import { inject } from "@harness/di";
import { RpcServerService } from "@harness/rpc";
import { StateSyncServerService } from "@harness/state-sync";
import { StreamServerService } from "@harness/stream";
import { WorkspaceCatalog } from "@harness/workspace-catalog";
import { WorkspaceStateSyncContract } from "./contract.ts";
import { WorkspaceFsService } from "./node-services.ts";
import { WorkspaceRpcContract, WorkspaceStreamContract, type WorkspaceWatchEvent } from "./rpc.ts";

export function useWorkspaceHandlers(): void {
  const fs = inject(WorkspaceFsService);
  const workspaces = inject(WorkspaceCatalog);

  inject(StateSyncServerService).useHandlers(WorkspaceStateSyncContract, {
    items: () => workspaces.host,
  });

  inject(RpcServerService).useHandlers(WorkspaceRpcContract, {
    browseRoot: () => ({ root: fs.getDefaultRoot() }),
    readDir: (input) => fs.readDir(input.root, input.relativePath, input.showIgnored),
    searchFiles: (input, ctx) => fs.searchFiles(input.root, input.query, ctx.signal),
    readFile: (input) => fs.readFile(input.root, input.relativePath),
    writeFile: (input) =>
      fs.writeFile(input.root, input.relativePath, input.content, input.expectedMtimeMs),
    createFile: (input) => fs.createFile(input.root, input.relativePath, input.content),
    createDir: (input) => fs.createDir(input.root, input.relativePath),
    renamePath: (input) => fs.renamePath(input.root, input.oldRelativePath, input.newRelativePath),
    deletePath: (input) => fs.deletePath(input.root, input.relativePath),
  });

  inject(StreamServerService).useHandlers(WorkspaceStreamContract, {
    watchRoots: async function* (input, ctx) {
      const queue: WorkspaceWatchEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = fs.subscribeRoots(input.roots, (event) => {
        queue.push(event);
        wake?.();
      });
      const onAbort = () => wake?.();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        while (!ctx.signal?.aborted) {
          if (queue.length > 0) yield queue.shift()!;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        ctx.signal?.removeEventListener("abort", onAbort);
        unsubscribe();
      }
    },
  });
}
