import type { ExtHostBridge } from "./bridge.ts";
import { CancellationTokenSource, Disposable, Uri, type CancellationToken } from "./types.ts";

interface ProfileContentHandler {
  // Extensions implement import/export storage for a profile.
  readonly name: string;
  readonly description?: string;
  readProfile(idOrUri: string | Uri, token: CancellationToken): PromiseLike<string | null>;
  saveProfile(
    name: string,
    content: string,
    token: CancellationToken,
  ): PromiseLike<{ id: string; link: Uri } | null>;
}

export function createProfileApi(bridge: ExtHostBridge) {
  const handlers = new Map<string, ProfileContentHandler>();
  const invoke = async <T>(
    id: unknown,
    action: (handler: ProfileContentHandler, token: CancellationToken) => PromiseLike<T>,
  ): Promise<T> => {
    const handler = handlers.get(String(id));
    if (!handler) throw new Error(`Unknown profile content handler: ${String(id)}`);
    const source = new CancellationTokenSource();
    try {
      return await action(handler, source.token);
    } finally {
      source.dispose();
    }
  };
  bridge.commandHandlers.set("__profiles.list", () =>
    [...handlers].map(([id, handler]) => ({
      id,
      name: handler.name,
      description: handler.description,
    })),
  );
  bridge.commandHandlers.set("__profiles.read", (id, resource) =>
    invoke(id, (handler, token) =>
      handler.readProfile(
        typeof resource === "string"
          ? resource
          : Uri.from(resource as Parameters<typeof Uri.from>[0]),
        token,
      ),
    ),
  );
  bridge.commandHandlers.set("__profiles.save", (id, name, content) =>
    invoke(id, (handler, token) => handler.saveProfile(String(name), String(content), token)),
  );
  return {
    registerProfileContentHandler(id: string, handler: ProfileContentHandler) {
      if (handlers.has(id)) throw new Error(`Profile content handler already registered: ${id}`);
      handlers.set(id, handler);
      return new Disposable(() => {
        if (handlers.get(id) === handler) handlers.delete(id);
      });
    },
  };
}
