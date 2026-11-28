import type { ExtHostBridge } from "./bridge.ts";
import type { HostTextEditor, EditorEditBuilder } from "./editor.ts";
import { Disposable, Uri } from "./types.ts";

export function registerOpenCommand(
  bridge: ExtHostBridge,
  showTextDocument: (uri: Uri, options?: unknown) => Promise<HostTextEditor>,
): void {
  bridge.commandHandlers.set("vscode.open", async (resource, options, label) => {
    const uri =
      typeof resource === "string" && /^https?:\/\//i.test(resource)
        ? Uri.parse(resource)
        : resource;
    if (!Uri.isUri(uri)) throw new TypeError("Expected a resource URI or an HTTP(S) URL");
    const scheme = uri.scheme.toLowerCase();
    if (scheme === "http" || scheme === "https") {
      await bridge.callMain(
        "env.openExternal",
        typeof resource === "string" ? resource : uri.toString(true),
      );
      return;
    }
    if (scheme === "file") {
      await bridge.callMain("commands.execute", "vscode.open", uri.toJSON(), options, label);
      return;
    }
    const editorOptions =
      typeof options === "number" ? { viewColumn: options } : (options as object);
    await showTextDocument(
      uri,
      typeof label === "string" && label ? { ...editorOptions, label } : options,
    );
  });
}

export function createCommandsNamespace(
  bridge: ExtHostBridge,
  getActiveEditor?: () => HostTextEditor | undefined,
) {
  const commands = {
    registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown,
      thisArg?: unknown,
    ): Disposable {
      if (!command || bridge.commandHandlers.has(command))
        throw new Error(`Command '${command}' is already registered or invalid`);
      const handler = callback.bind(thisArg);
      bridge.commandHandlers.set(command, handler);
      void bridge.callMain("commands.register", command);
      return new Disposable(() => {
        if (bridge.commandHandlers.get(command) !== handler) return;
        bridge.commandHandlers.delete(command);
        void bridge.callMain("commands.unregister", command);
      });
    },
    registerTextEditorCommand(
      command: string,
      callback: (editor: HostTextEditor, edit: EditorEditBuilder, ...args: unknown[]) => unknown,
      thisArg?: unknown,
    ): Disposable {
      return commands.registerCommand(command, async (...args) => {
        const editor = getActiveEditor?.();
        if (!editor) return undefined;
        await editor.edit((builder) => {
          callback.call(thisArg, editor, builder, ...args);
        });
        return undefined;
      });
    },
    async executeCommand(command: string, ...args: unknown[]) {
      if (!bridge.commandHandlers.has(command))
        await bridge.activateByEvent?.(`onCommand:${command}`);
      const local = bridge.commandHandlers.get(command);
      if (local) {
        return await local(...args);
      }
      return bridge.callMain("commands.execute", command, ...args);
    },
    async getCommands(filterInternal = false): Promise<string[]> {
      const main = (await bridge.callMain("commands.getCommands")) as string[] | undefined;
      return [...new Set([...bridge.commandHandlers.keys(), ...(main ?? [])])].filter(
        (command) => !command.startsWith("__") && (!filterInternal || !command.startsWith("_")),
      );
    },
  };
  return commands;
}
