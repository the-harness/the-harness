import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";
import TerminalPanel from "./components/TerminalPanel.vue";
import { UiTerminalService } from "./index.ts";

export function useTerminalWorkbench(): void {
  const workbench = inject(UiWorkbenchService);
  const terminalService = inject(UiTerminalService);
  workbench.use({
    id: "harness.terminal",
    panels: [
      {
        id: "terminal",
        title: "Terminal",
        icon: "i-codicon-terminal",
        component: TerminalPanel,
        location: "below",
        presentation: "view",
        titleActions: [
          {
            id: "clear-terminal",
            title: "Clear output",
            icon: "i-codicon-clear-all",
            run: () => {},
          },
          {
            id: "close-terminal",
            title: "Kill terminal",
            icon: "i-codicon-trash",
            run: () => {
              if (terminalService.activeId.value) {
                void terminalService.kill(terminalService.activeId.value);
              }
            },
          },
        ],
      },
    ],
  });
}
