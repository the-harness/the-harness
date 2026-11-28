import { ProgressLocation } from "@harness/vscode-types";
import { reactive } from "vue";
import type { ProgressOptions } from "../vscode/progress.ts";

export interface ProgressEntry {
  readonly id: string;
  readonly title: string;
  readonly location: ProgressOptions["location"];
  readonly cancellable: boolean;
  message?: string;
  worked?: number;
}

export function createMainThreadProgress(sendCancel: (id: string) => void) {
  const entries = reactive(new Map<string, ProgressEntry>());

  return {
    entries,
    handle(method: string, args: unknown[]): boolean {
      if (method === "window.progressStart") {
        const [id, title, location = ProgressLocation.Notification, cancellable = false] = args as [
          string,
          string,
          ProgressOptions["location"]?,
          boolean?,
        ];
        entries.set(id, { id, title, location, cancellable });
        return true;
      }
      if (method === "window.progressReport") {
        const [id, , message, increment] = args as [
          string,
          string,
          string | null,
          number | null | undefined,
        ];
        const entry = entries.get(id);
        if (entry) {
          if (typeof message === "string") entry.message = message;
          if (typeof increment === "number" && Number.isFinite(increment)) {
            entry.worked = Math.min(100, Math.max(0, (entry.worked ?? 0) + increment));
          }
        }
        return true;
      }
      if (method === "window.progressEnd") {
        entries.delete(args[0] as string);
        return true;
      }
      return false;
    },
    cancel(entry: ProgressEntry): void {
      if (
        entries.get(entry.id) !== entry ||
        !entry.cancellable ||
        entry.location !== ProgressLocation.Notification
      ) {
        return;
      }
      entries.delete(entry.id);
      sendCancel(entry.id);
    },
    dispose(): void {
      entries.clear();
    },
  };
}
