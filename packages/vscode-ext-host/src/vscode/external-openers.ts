import type { ExtHostBridge } from "./bridge.ts";
import type { ShowQuickPick } from "./quick-input.ts";
import { CancellationTokenSource, Disposable, Uri, type CancellationToken } from "./types.ts";

interface ExternalUriOpener {
  // Extensions decide which HTTP resources they can present and open a chosen resource.
  canOpenExternalUri(uri: Uri, token: CancellationToken): number | PromiseLike<number>;
  openExternalUri(
    uri: Uri,
    context: { sourceUri: Uri },
    token: CancellationToken,
  ): void | PromiseLike<void>;
}

export function createExternalUriOpenerApi(bridge: ExtHostBridge, showQuickPick: ShowQuickPick) {
  const openers = new Map<
    string,
    { opener: ExternalUriOpener; metadata: { schemes: readonly string[]; label: string } }
  >();
  bridge.commandHandlers.set("__externalUri.open", async (raw, preference) => {
    const uri = raw instanceof Uri ? raw : Uri.from(raw as Parameters<typeof Uri.from>[0]);
    if (!preference || preference === "default") return undefined;
    await bridge.activateByEvent?.(`onOpenExternalUri:${uri.scheme}`);
    const cancellation = new CancellationTokenSource();
    try {
      const eligible = [...openers].filter(([, value]) =>
        value.metadata.schemes.includes(uri.scheme),
      );
      let selected =
        typeof preference === "string"
          ? eligible.find(([id]) => id === preference)?.[0]
          : undefined;
      if (preference === true) {
        const ranked = await Promise.all(
          eligible.map(async ([id, value]) => ({
            id,
            label: value.metadata.label,
            priority: await value.opener.canOpenExternalUri(uri, cancellation.token),
          })),
        );
        const preferred = ranked.filter((value) => value.priority === 3);
        if (preferred.length === 1) selected = preferred[0]!.id;
        else if (ranked.some((value) => value.priority >= 2)) {
          const browser = { id: "default", label: "Open in browser" };
          const choice = await showQuickPick(
            [browser, ...ranked.filter((value) => value.priority > 0)],
            { title: "Open link with" },
          );
          if (!choice) return false;
          if (choice === browser) return undefined;
          selected = choice.id;
        }
      }
      const match = selected && openers.get(selected);
      if (!match) return undefined;
      await match.opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
      return true;
    } finally {
      cancellation.dispose();
    }
  });
  return {
    registerExternalUriOpener(
      id: string,
      opener: ExternalUriOpener,
      metadata: { schemes: readonly string[]; label: string },
    ) {
      if (openers.has(id)) throw new Error(`External URI opener already registered: ${id}`);
      if (metadata.schemes.some((scheme) => scheme !== "http" && scheme !== "https"))
        throw new Error("External URI openers only support http and https");
      openers.set(id, { opener, metadata });
      return new Disposable(() => {
        if (openers.get(id)?.opener === opener) openers.delete(id);
      });
    },
  };
}
