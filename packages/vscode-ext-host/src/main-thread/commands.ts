import type { UiCommandsService } from "@harness/ui-commands";
import { shallowReactive } from "vue";

export function createMainThreadCommands(commands: Pick<UiCommandsService, "has" | "execute">) {
  const contexts = shallowReactive(new Map<string, unknown>());
  return {
    contexts,
    async execute(command: string, args: unknown[]) {
      if (command === "setContext") {
        const [key, value] = args;
        if (typeof key !== "string") throw new TypeError("Context key must be a string");
        if (value === undefined) contexts.delete(key);
        else contexts.set(key, value);
        return;
      }
      if (commands.has(command)) return await commands.execute(command, ...args);
      if (command === "_workbench.whenAccountPolicySettled") {
        // Without a managed-account policy source, the local Harness gate is inactive and has no pending initialization.
        return;
      }
      if (command === "_chat.editSessions.accept") {
        // Harness agent edits are applied directly; there are no deferred chat editing sessions to accept.
        return;
      }
      if (command === "_aiEdits.hasAiContributions") return false;
      if (
        command === "_aiEdits.clearAiContributions" ||
        command === "_aiEdits.clearAllAiContributions"
      ) {
        // VS Code also supplies these fallbacks while AI contribution tracking is inactive.
        return;
      }
      throw new Error(`Command '${command}' not found`);
    },
  };
}
