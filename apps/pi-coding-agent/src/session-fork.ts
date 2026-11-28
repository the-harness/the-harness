import { Context } from "@harness/context";
import { createDescriptor, type Scope } from "@harness/di";
import type { SessionCatalog } from "./session-catalog.ts";
import { isSessionFile, loadPiSession } from "./session-import.ts";

export async function forkStartupSession(
  root: Scope,
  catalog: SessionCatalog,
  cwd: string,
  reference: string,
  id = crypto.randomUUID(),
): Promise<string> {
  if (catalog.get(id)) throw new Error(`Session already exists with id '${id}'`);

  // A fresh storage branch cannot overwrite an existing session if two launches request the same ID.
  const branchId = crypto.randomUUID();
  const scope = root.createChild();
  try {
    if (!catalog.get(reference) && isSessionFile(reference, cwd)) {
      const imported = await loadPiSession(reference, cwd);
      scope.provide(createDescriptor(Context, { id: branchId, initialPending: imported.messages }));
      scope.get(Context).batch();
      await catalog.createFork({
        id,
        cwd,
        parent: imported.path,
        name: imported.name,
        provider: imported.model?.provider,
        model: imported.model?.model,
        thinking: imported.thinking,
        tree: {
          branchId,
          leafId: imported.leafId,
          entries: imported.transcript.entries,
          nativeToPi: imported.transcript.nativeToPi,
          checkpoints: [],
          importedEntryIds: imported.transcript.entries.map(({ id }) => id),
        },
      });
    } else {
      const source = catalog.resolve(reference, cwd);
      const tree = catalog.getTree(source.id);
      scope.provide(createDescriptor(Context, { id: source.id, branchId: tree?.branchId }));
      await scope.get(Context).fork({ id: branchId });
      await catalog.createFork({
        id,
        cwd,
        parent: source.id,
        name: source.name ?? undefined,
        provider: source.model_provider ?? undefined,
        model: source.model_id ?? undefined,
        thinking: source.thinking ?? undefined,
        tree: {
          branchId,
          leafId: tree?.leafId ?? null,
          entries: tree?.entries ?? [],
          nativeToPi: tree?.nativeToPi ?? [],
          checkpoints: [],
          importedEntryIds: tree?.importedEntryIds ?? [],
        },
      });
    }
    return id;
  } finally {
    scope.dispose();
  }
}
