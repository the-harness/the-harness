import { AgentLoop } from "@harness/agent-loop";
import { Context } from "@harness/context";
import { createDescriptor, inject } from "@harness/di";
import {
  AssistantMessage,
  extractText,
  TextBlock,
  ToolResultMessage,
  UserMessage,
  type Message,
} from "@harness/llm";
import { AgentManager } from "@harness/subagent";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";

export const subagentParameters = z.object({
  prompt: z.string().describe("Task instructions or message to send to the agent"),
  name: z
    .string()
    .optional()
    .describe("Agent name to create or continue conversing with. Omit to auto-generate"),
  fork: z
    .boolean()
    .optional()
    .describe(
      "When creating a new agent, fork the caller's current context instead of starting empty",
    ),
});

async function extractReplyText(context: Context, inputId: string): Promise<string> {
  let reply: string | undefined;
  const reachedInput = (messages: readonly Message[]): boolean => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.id === inputId) return true;
      if (reply === undefined && message instanceof AssistantMessage) {
        reply = extractText(message.content);
      }
    }
    return false;
  };

  if (reachedInput(context.pending)) return reply ?? "";
  for await (const { messages } of context.readBackward()) {
    if (reachedInput(messages)) return reply ?? "";
  }
  return "";
}

export function useSubagentTool(): void {
  const toolCall = inject(ToolCallService);
  const agentManager = inject(AgentManager);
  const callerContext = inject(Context);
  const callerLoop = inject(AgentLoop);

  toolCall.useTool(functionTool({
    name: "subagent",
    description:
      "Delegate a task or send a message to another agent in the session. Provide 'name' to continue conversing with an existing agent or create one with that name; omit 'name' to create a new agent. Set 'fork' to true to fork the current context.",
    parameters: subagentParameters,
    async execute({ prompt, name, fork }, { callId, signal }) {
      signal.throwIfAborted();

      let targetScope = name !== undefined ? agentManager.agents.get(name) : undefined;
      if (targetScope !== undefined && fork) {
        throw new Error(`agent '${targetScope.id}' already exists; cannot fork into it`);
      }
      if (targetScope === undefined) {
        if (fork) {
          const contextOptions = await callerContext.fork();
          targetScope = agentManager.create({ id: name });
          targetScope.provideAll([createDescriptor(Context, contextOptions)]);
        } else {
          targetScope = agentManager.create({ id: name });
        }
        const targetLoop = targetScope.get(AgentLoop);
        if (!targetLoop.options.provider && !targetLoop.options.model) {
          targetLoop.options = { ...callerLoop.options };
        }
      }

      const targetContext = targetScope.get(Context);
      const targetLoop = targetScope.get(AgentLoop);
      if (targetLoop.isRunning) {
        throw new Error(`loop is already running for context '${targetContext.id}'`);
      }

      if (fork) {
        const idx = targetContext.pending.findIndex(
          (msg) => msg instanceof ToolResultMessage && msg.toolCallId === callId,
        );
        if (idx !== -1) {
          targetContext.pending[idx] = ToolResultMessage.create({
            toolCallId: callId,
            toolName: "subagent",
            content: [TextBlock.create({ text: "Context forked to subagent." })],
            isError: false,
          });
        }
      }

      const input = UserMessage.create({ content: [TextBlock.create({ text: prompt })] });
      targetContext.pending.push(input);

      const onAbort = () => targetLoop.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const stopReason = await targetLoop.run();
        if (stopReason === "aborted" || signal.aborted) {
          throw new Error(`subagent '${targetScope.id}' aborted`);
        }
        const reply = await extractReplyText(targetContext, input.id);
        return reply ? `[${targetScope.id}]\n${reply}` : `[${targetScope.id}] (${stopReason})`;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  }));
}
