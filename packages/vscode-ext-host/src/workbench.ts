import { inject } from "@harness/di";
import {
  AppearanceSettingsSlot,
  ChatInputNotificationSlot,
  StatusBarSlot,
  ViewProgressSlot,
  UiTabsService,
  UiWorkbenchService,
} from "@harness/ui-workbench";
import { WebviewPanelView, WebviewTabDescriptor } from "@harness/ui-webview";
import { ExtensionHostClientService } from "./client.ts";
import ExtensionTreeViewsPanel from "./components/ExtensionTreeViewsPanel.vue";
import ChatInputNotifications from "./components/ChatInputNotifications.vue";
import ChatStatusItems from "./components/ChatStatusItems.vue";
import ExtensionCommentsPanel from "./components/ExtensionCommentsPanel.vue";
import ExtensionAppearanceSettings from "./components/ExtensionAppearanceSettings.vue";
import ExtensionProgressOverlay from "./components/ExtensionProgressOverlay.vue";
import ExtensionViewProgress from "./components/ExtensionViewProgress.vue";
import { useLegacySecretMigration } from "./legacy-secret-migration.ts";

export function useExtHostWorkbench(): void {
  const workbench = inject(UiWorkbenchService);
  inject(ExtensionHostClientService);
  useLegacySecretMigration();
  AppearanceSettingsSlot.use(ExtensionAppearanceSettings);
  StatusBarSlot.use(ExtensionProgressOverlay);
  ViewProgressSlot.use(ExtensionViewProgress);
  ChatInputNotificationSlot.use(ChatInputNotifications);
  ChatInputNotificationSlot.use(ChatStatusItems);
  inject(UiTabsService).useRenderer({
    descriptor: WebviewTabDescriptor,
    component: WebviewPanelView,
    icon: "i-codicon-preview",
  });
  workbench.use({
    id: "harness.ext-host",
    panels: [
      {
        id: "ext-comments",
        title: "Comments",
        icon: "i-codicon-comment-discussion",
        component: ExtensionCommentsPanel,
        location: "right",
        presentation: "view",
      },
      {
        id: "ext-treeviews",
        title: "Extensions",
        icon: "i-codicon-extensions",
        component: ExtensionTreeViewsPanel,
        location: "right",
        presentation: "view",
      },
    ],
  });
}
