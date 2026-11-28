import { inject } from "@harness/di";
import { UiCommandsService } from "@harness/ui-commands";
import { effectScope } from "vue";
import { type Disposable, type Uri } from "./index.ts";

export class VscodeCommandsCompatService {
  private readonly commands = inject(UiCommandsService);

  registerCommand(command: string, callback: (...args: any[]) => unknown): Disposable {
    const scope = effectScope();
    scope.run(() => {
      this.commands.useCommand(command, callback);
    });
    return { dispose: () => scope.stop() };
  }

  async executeCommand<T = unknown>(command: string, ...rest: any[]): Promise<T | undefined> {
    return await this.commands.execute<T>(command, ...rest);
  }

  async getCommands(filterInternal = false): Promise<string[]> {
    const keys = this.commands.commands.value.map((item) => item.id);
    return filterInternal ? keys.filter((k) => !k.startsWith("_")) : keys;
  }
}

export class VscodeEnvCompatService {
  readonly appName = "Harness";
  readonly language = typeof navigator !== "undefined" ? navigator.language : "en";

  readonly clipboard = {
    readText: async (): Promise<string> => {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        return await navigator.clipboard.readText();
      }
      return "";
    },
    writeText: async (value: string): Promise<void> => {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      }
    },
  };

  async openExternal(target: Uri | string): Promise<boolean> {
    if (typeof window !== "undefined") {
      const href = typeof target === "string" ? target : target.toString();
      window.open(href, "_blank", "noopener,noreferrer");
      return true;
    }
    return false;
  }
}
