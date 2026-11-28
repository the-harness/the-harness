import type { VscodeConfigAdapter } from "./vscode-config.ts";
import type { UiNotificationService } from "@harness/ui-notifications";
import type { UiWorkbenchService } from "@harness/ui-workbench";
import { queueContributionUpdate } from "@harness/vscode-editor-compat/contribution-state";
import {
  createExtensionContributions,
  type ExtensionContributions,
  type ExtensionContributionSnapshot,
} from "@harness/vscode-editor-compat/contributions";
import { effectScope, watch, type EffectScope } from "vue";
import { readConfigurationDefaults } from "./configuration-defaults.ts";

export class ClientContributions {
  private readonly scope = effectScope();
  private adapter?: ExtensionContributions;
  private defaults?: EffectScope;
  private disposed = false;
  private load = 0;
  private pending = Promise.resolve();

  constructor(
    private readonly config: Pick<VscodeConfigAdapter, "get" | "useDefaults">,
    private readonly workbench: Pick<UiWorkbenchService, "theme">,
    private readonly notifications: Pick<UiNotificationService, "notify">,
    private readonly getSnapshots: () => Promise<readonly ExtensionContributionSnapshot[]>,
  ) {
    watch(
      () => [this.config.get<string>("workbench.colorTheme"), this.workbench.theme.value] as const,
      ([configured, kind]) => {
        const id = configured ?? (kind === "dark" ? "Dark+" : "Light+");
        if (this.adapter?.availableThemes.some((theme) => theme.id === id))
          this.adapter.setTheme(id);
      },
    );
    watch(
      () => this.config.get<string>("workbench.iconTheme", "vs-seti"),
      (id) => {
        if (id && this.adapter?.availableIconThemes.some((theme) => theme.id === id))
          this.adapter.setIconTheme(id);
      },
    );
  }

  get generation(): number {
    return this.load;
  }

  get queuedUpdate(): Promise<void> {
    return this.pending;
  }

  async refresh(): Promise<void> {
    const load = ++this.load;
    const snapshots = await this.getSnapshots();
    this.pending = queueContributionUpdate(async () => {
      if (this.disposed || load !== this.load) return;
      this.clear();
      if (!snapshots.length) return;

      const defaults = readConfigurationDefaults(snapshots.map(({ contributes }) => contributes));
      this.defaults = this.scope.run(() => effectScope());
      this.defaults?.run(() => this.config.useDefaults(defaults));
      const adapter = await createExtensionContributions(snapshots, {
        theme: this.config.get<string>("workbench.colorTheme"),
        themeKind: this.workbench.theme.value,
        iconTheme: this.config.get<string>("workbench.iconTheme", "vs-seti"),
        getMaxTokenizationLineLength: (languageId) =>
          this.config.get<number>("editor.maxTokenizationLineLength", undefined, languageId),
      });
      if (this.disposed || load !== this.load) {
        adapter.dispose();
        return;
      }
      this.adapter = adapter;
      for (const issue of adapter.issues)
        this.notifications.notify(`${issue.extensionId}: ${issue.message}`);
    });
    await this.pending;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.scope.stop();
  }

  private clear(): void {
    this.adapter?.dispose();
    this.adapter = undefined;
    this.defaults?.stop();
    this.defaults = undefined;
  }
}
