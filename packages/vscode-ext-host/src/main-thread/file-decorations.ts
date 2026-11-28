import { reactive } from "vue";

export interface FileDecoration {
  readonly badge?: string;
  readonly tooltip?: string;
  readonly color?: string;
}

export function createMainThreadFileDecorations(
  executeCommand: (sessionId: string, command: string, args: unknown[]) => Promise<unknown>,
) {
  const providers = reactive(
    new Map<string, (uriPath: string) => Promise<FileDecoration | undefined>>(),
  );

  const handle = (sessionId: string, method: string, args: unknown[]): boolean => {
    if (method === "window.registerFileDecorationProvider") {
      const [id] = args as [string];
      providers.set(id, async (uriPath) => {
        const res = await executeCommand(sessionId, `__fileDeco.provide.${id}`, [uriPath]);
        return (res as FileDecoration | undefined) ?? undefined;
      });
      return true;
    }
    if (method === "window.unregisterFileDecorationProvider") {
      const [id] = args as [string];
      providers.delete(id);
      return true;
    }
    return false;
  };

  const getDecoration = async (uriPath: string): Promise<FileDecoration | undefined> => {
    for (const provide of providers.values()) {
      const deco = await provide(uriPath);
      if (deco) return deco;
    }
    return undefined;
  };

  return { providers, handle, getDecoration };
}
