import { inject } from "@harness/di";
import { SecretStorageService } from "@harness/secret-storage";
import { SqliteService } from "@harness/sqlite";
import { onScopeDispose } from "reactivity";
import { z } from "zod";
import type { ExtensionHostService } from "../service.ts";
import { LegacyExtensionSecretsSchema } from "../rpc.ts";

export function useExtensionSecrets(host: ExtensionHostService) {
  const storage = inject(SecretStorageService);
  const sqlite = inject(SqliteService);
  const subscriptions = new Map<string, Set<string>>();

  async function notify(extensionId: string, key: string): Promise<void> {
    const recipients = [...subscriptions].filter(([, extensions]) => extensions.has(extensionId));
    await Promise.allSettled(
      recipients.map(([id]) => host.executeCommand(id, "__secrets.onDidChange", extensionId, key)),
    );
  }

  const extension = z.string().min(1);
  const string = z.string();
  const stopRouter = host.registerMainThreadRouter(async (sessionId, method, args) => {
    switch (method) {
      case "secrets.subscribe": {
        const [extensionId] = z.tuple([extension]).parse(args);
        const extensions = subscriptions.get(sessionId) ?? new Set<string>();
        extensions.add(extensionId);
        subscriptions.set(sessionId, extensions);
        return { handled: true };
      }
      case "secrets.get": {
        const [extensionId, key] = z.tuple([extension, string]).parse(args);
        return { handled: true, value: storage.get(extensionId, key) };
      }
      case "secrets.store": {
        const [extensionId, key, value] = z.tuple([extension, string, string]).parse(args);
        if (storage.store(extensionId, key, value) === "changed") {
          await notify(extensionId, key);
        }
        return { handled: true };
      }
      case "secrets.delete": {
        const [extensionId, key] = z.tuple([extension, string]).parse(args);
        if (storage.delete(extensionId, key)) await notify(extensionId, key);
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  });
  host.hooks.sessionStopped.use((sessionId, next) => {
    subscriptions.delete(sessionId);
    return next();
  });
  onScopeDispose(() => {
    stopRouter();
    subscriptions.clear();
  });

  return async (input: unknown): Promise<number[]> => {
    const entries = LegacyExtensionSecretsSchema.parse(input);
    const migrated: number[] = [];
    for (const [index, { extensionId, key, value }] of entries.entries()) {
      const result = storage.store(extensionId, key, value, { keepExisting: true });
      if (result === "conflict") continue;
      migrated.push(index);
      if (result === "changed") await notify(extensionId, key);
    }
    // 客户端收到确认后会删除旧凭据。
    await sqlite.flush();
    return migrated;
  };
}
