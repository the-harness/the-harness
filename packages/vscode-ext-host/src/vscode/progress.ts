import {
  CancellationTokenSource,
  ProgressLocation,
  type CancellationToken,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

export interface ProgressOptions {
  location: ProgressLocation | { viewId: string };
  title?: string;
  cancellable?: boolean;
}

interface ProgressStep {
  message?: string;
  increment?: number;
}

export function createWithProgress(bridge: ExtHostBridge) {
  let nextId = 0;
  const cancellable = new Map<string, CancellationTokenSource>();
  bridge.commandHandlers.set("__win.progress.cancel", (id) => {
    cancellable.get(String(id))?.cancel();
  });

  return async function withProgress<R>(
    options: ProgressOptions,
    task: (
      progress: { report(value: ProgressStep): void },
      token: CancellationToken,
    ) => PromiseLike<R>,
  ): Promise<R> {
    const id = `prog-${++nextId}`;
    const title = options.title ?? "Working…";
    const location = options.location ?? ProgressLocation.Notification;
    const source = new CancellationTokenSource();
    let running = true;
    if (options.cancellable) cancellable.set(id, source);
    void bridge.callMain("window.progressStart", id, title, location, !!options.cancellable);
    try {
      return await task(
        {
          report({ message, increment }) {
            if (!running) return;
            void bridge.callMain(
              "window.progressReport",
              id,
              title,
              message ?? null,
              increment ?? null,
            );
          },
        },
        source.token,
      );
    } finally {
      running = false;
      cancellable.delete(id);
      source.dispose();
      void bridge.callMain("window.progressEnd", id);
    }
  };
}
