import { UiTerminalService } from "@harness/ui-terminal";
import { createMainThreadTasks } from "../../../packages/vscode-ext-host/src/main-thread/tasks.ts";

export async function observeTaskWithoutTerminalPanel() {
  const terminal = new UiTerminalService();
  const events: unknown[] = [];
  const finished = Promise.withResolvers<void>();
  const tasks = createMainThreadTasks(terminal, {} as never, async (command, args) => {
    if (command === "__tasks.started") events.push(["start", Number(args[1]) > 0]);
    else if (command === "__tasks.output") events.push(["output", args[1]]);
    else if (command === "__tasks.ended") {
      events.push(["end", args[1]]);
      finished.resolve();
    } else throw new Error(`Unexpected task callback: ${command}`);
  });
  try {
    await tasks("tasks.execute", [
      "fixture",
      {
        name: "Task observer fixture",
        shell: "/bin/sh",
        args: ["-c", "printf 'TASK_WITHOUT_PANEL_OK\\n'; exit 7"],
      },
    ]);
    await finished.promise;
    return events;
  } finally {
    tasks.dispose();
    for (const tab of terminal.terminals) await terminal.kill(tab.id);
  }
}
