import type { ExtHostBridge } from "./bridge.ts";
import type { createWebviewApi } from "./webviews.ts";
import type { createWorkspaceNamespace } from "./workspace.ts";
import { CancellationTokenSource, Disposable, Uri, type CancellationToken } from "./types.ts";

type Panel = ReturnType<ReturnType<typeof createWebviewApi>["createWebviewPanel"]>;
type CustomDocument = { readonly uri: Uri; dispose(): void };
interface CustomEditorProvider {
  // Extensions implement a text editor resolver or a custom document and its readonly renderer.
  resolveCustomTextEditor?(
    document: Awaited<ReturnType<ReturnType<typeof createWorkspaceNamespace>["openTextDocument"]>>,
    panel: Panel,
    token: CancellationToken,
  ): void | PromiseLike<void>;
  openCustomDocument?(
    uri: Uri,
    context: { backupId?: string; untitledDocumentData?: Uint8Array },
    token: CancellationToken,
  ): CustomDocument | PromiseLike<CustomDocument>;
  resolveCustomEditor?(
    document: CustomDocument,
    panel: Panel,
    token: CancellationToken,
  ): void | PromiseLike<void>;
}

export function createCustomEditorApi(
  bridge: ExtHostBridge,
  webviews: ReturnType<typeof createWebviewApi>,
  openTextDocument: ReturnType<typeof createWorkspaceNamespace>["openTextDocument"],
) {
  const registrations = new Set<string>();
  return {
    registerCustomEditorProvider(
      viewType: string,
      provider: CustomEditorProvider,
      options?: {
        webviewOptions?: { retainContextWhenHidden?: boolean; enableFindWidget?: boolean };
        supportsMultipleEditorsPerDocument?: boolean;
      },
    ) {
      if (registrations.has(viewType))
        throw new Error(`Custom editor provider already registered: ${viewType}`);
      if (
        !provider.resolveCustomTextEditor &&
        (!provider.openCustomDocument || !provider.resolveCustomEditor)
      )
        throw new TypeError("Custom editor provider must resolve a text or custom document");
      registrations.add(viewType);
      const owner = bridge.getExtensionPath?.();
      const panels = new Map<string, Set<Panel>>();
      const documents = new Map<string, Promise<CustomDocument>>();
      const command = `__customEditor.resolve.${viewType}`;
      bridge.commandHandlers.set(command, async (raw) => {
        const uri =
          typeof raw === "string" ? Uri.file(raw) : Uri.from(raw as Parameters<typeof Uri.from>[0]);
        const key = uri.toString();
        const existing = panels.get(key);
        if (!options?.supportsMultipleEditorsPerDocument && existing?.size) {
          existing.values().next().value!.reveal();
          return;
        }
        const panel = webviews.createWebviewPanel(
          viewType,
          uri.path.split("/").at(-1) ?? viewType,
          1,
          options?.webviewOptions,
          owner,
        );
        const active = existing ?? new Set<Panel>();
        active.add(panel);
        panels.set(key, active);
        const cancellation = new CancellationTokenSource();
        panel.onDidDispose(() => {
          cancellation.cancel();
          active.delete(panel);
          if (!active.size) {
            panels.delete(key);
            const document = documents.get(key);
            documents.delete(key);
            void document?.then(
              (value) => value.dispose(),
              () => {},
            );
          }
        });
        try {
          if (provider.resolveCustomTextEditor)
            await provider.resolveCustomTextEditor(
              await openTextDocument(uri),
              panel,
              cancellation.token,
            );
          else {
            let document = documents.get(key);
            if (!document) {
              document = Promise.resolve(provider.openCustomDocument!(uri, {}, cancellation.token));
              documents.set(key, document);
            }
            await provider.resolveCustomEditor!(await document, panel, cancellation.token);
          }
        } catch (error) {
          panel.dispose();
          throw error;
        } finally {
          cancellation.dispose();
        }
      });
      void bridge.callMain("window.registerCustomEditorProvider", viewType);
      return new Disposable(() => {
        for (const active of [...panels.values()]) for (const panel of [...active]) panel.dispose();
        registrations.delete(viewType);
        bridge.commandHandlers.delete(command);
        void bridge.callMain("window.unregisterCustomEditorProvider", viewType);
      });
    },
  };
}
