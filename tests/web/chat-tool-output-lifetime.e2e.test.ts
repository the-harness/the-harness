import { expect, it, vi } from "vite-plus/test";
import { z } from "../../packages/tool-call/node_modules/zod/index.js";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("keeps finished tool output callbacks out of later chat runs", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, chat, di, llm, models, mock, presets, tools] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/chat-session/src/index.ts")>(
        "/packages/chat-session/src/index.ts",
      ),
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/llm/src/index.ts")>("/packages/llm/src/index.ts"),
      modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
        "/packages/model-provider/src/index.ts",
      ),
      modules.load<typeof import("../../packages/mock-llm/src/index.ts")>(
        "/packages/mock-llm/src/index.ts",
      ),
      modules.load<typeof import("../../packages/agent-preset/src/index.ts")>(
        "/packages/agent-preset/src/index.ts",
      ),
      modules.load<typeof import("../../packages/tool-call/src/index.ts")>(
        "/packages/tool-call/src/index.ts",
      ),
    ]);
    const { SessionManager } = await modules.load<
      typeof import("../../packages/session-manager/src/index.ts")
    >("/packages/session-manager/src/index.ts");
    const scope = web.createServerScope();
    const gate = new mock.MockGate();
    const saved: { report?: (delta: string) => void } = {};
    try {
      class ToolOutputPreset extends presets.AgentPreset {
        readonly id = "tool-output-fixture";
        readonly name = "Tool output fixture";

        override setup(): void {
          tools.useToolCall();
          di.inject(tools.ToolCallService).useTool(tools.functionTool({
            name: "report_progress",
            description: "Report progress",
            parameters: z.object({}),
            execute: (_input, { reportOutput }) => {
              saved.report = reportOutput;
              reportOutput?.("while running");
              return "Done";
            },
          }));
        }
      }
      const preset = new ToolOutputPreset();
      scope.run(() => di.inject(presets.AgentPresetRegistry).usePreset(preset));

      const provider = scope.get(models.ProviderManager).create({ id: "mock" });
      provider.provide(llm.LlmProvider, di.createDescriptor(mock.ScriptedMockLlmProvider));
      const scripted = provider.get(llm.LlmProvider) as InstanceType<
        typeof mock.ScriptedMockLlmProvider
      >;
      scripted.enqueue(
        {
          toolCalls: [{ id: "first-call", name: "report_progress", arguments: {} }],
          stopReason: "tool_calls",
        },
        "First run finished",
        async (ctx) => {
          await gate.wait(ctx.signal);
          return "Second run finished";
        },
      );

      const sessionId = "tool-output-lifetime";

      const session = scope.get(SessionManager).acquire(sessionId).get(chat.ChatSession);
      const start = (text: string) => {
        session.pending.items.push(
            llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] }),
          );
        return Array.fromAsync(
          session.stream({ modelId: "mock", presetId: preset.id }),
        );
      };

      const first = await start("Run the tool");
      expect(first).toContainEqual({
        type: "tool_output",
        id: "first-call",
        delta: "while running",
      });
      expect(first).toContainEqual({
        type: "chunk",
        chunk: { type: "text_delta", delta: "First run finished" },
      });
      expect(saved.report).toBeTypeOf("function");

      const second = start("Continue");
      try {
        const entered = await Promise.race([
          gate.arrived.then(() => true),
          second.then(() => false),
        ]);
        expect(entered).toBe(true);
        saved.report?.("late output");
        gate.release();
        expect((await second).filter((event) => event.type === "chunk")).toEqual([
          { type: "chunk", chunk: { type: "text_delta", delta: "Second run finished" } },
        ]);
      } finally {
        gate.release();
        await second;
      }
    } finally {
      scope.dispose();
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
  }
});
