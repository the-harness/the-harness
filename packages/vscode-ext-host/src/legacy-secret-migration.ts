import { inject } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { UiCommandsService } from "@harness/ui-commands";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiQuickInputService } from "@harness/ui-quick-input";
import { UiStorageService } from "@harness/ui-storage";
import { z } from "zod";
import { ExtHostRpcContract } from "./rpc.ts";

const LegacyStorage = z.looseObject({
  secrets: z.record(z.string(), z.string()).default({}),
});

export function useLegacySecretMigration(): void {
  const storage = inject(UiStorageService).scope("vscode", "auth");
  const bucket = `${storage.prefix}:core:vscode-auth`;
  const rpc = inject(RpcClientService).use(ExtHostRpcContract);
  const quickInput = inject(UiQuickInputService);
  const notifications = inject(UiNotificationService);
  const readLegacy = () =>
    LegacyStorage.parse(JSON.parse(storage.localStorage.getItem(bucket) ?? "{}"));
  let migrating = false;

  inject(UiCommandsService).useCommand(
    "extensions.migrateLegacySecrets",
    async () => {
      if (migrating) return;
      migrating = true;
      try {
        const { secrets } = readLegacy();
        const entries = Object.entries(secrets).flatMap(([legacyKey, value]) => {
          const separator = legacyKey.indexOf(":");
          if (separator <= 0) return [];
          return [
            {
              legacyKey,
              extensionId: legacyKey.slice(0, separator),
              key: legacyKey.slice(separator + 1),
              value,
            },
          ];
        });
        if (entries.length === 0) {
          notifications.notify("No legacy extension credentials to migrate.");
          return;
        }
        const selected = await quickInput.showQuickPick(
          [
            {
              label: "Migrate credentials",
              description: "Move credentials from this browser to this Harness instance",
            },
          ],
          { title: "Migrate locally saved extension credentials" },
        );
        if (!selected) return;

        const migrated = await rpc.importLegacySecrets(
          entries.map(({ extensionId, key, value }) => ({
            extensionId,
            key,
            value,
          })),
        );
        const latest = readLegacy();
        for (const index of migrated) {
          const entry = entries[index];
          if (entry && latest.secrets[entry.legacyKey] === entry.value) {
            delete latest.secrets[entry.legacyKey];
          }
        }
        const remaining = Object.keys(latest.secrets).length;
        if (remaining === 0 && Object.keys(latest).length === 1) {
          storage.localStorage.removeItem(bucket);
        } else {
          storage.localStorage.setItem(bucket, JSON.stringify(latest));
        }
        notifications.notify(
          `Migrated ${migrated.length} extension credential(s). ${remaining} local value(s) remain.`,
        );
      } catch {
        notifications.notify(
          "Could not complete extension credential migration. Check the server's secret storage setup and try again.",
        );
      } finally {
        migrating = false;
      }
    },
    { title: "Migrate legacy credentials", category: "Extensions" },
  );
}
