import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "streams an extension model through Harness and removes its registration when the session is replaced",
  {
    timeout: 60_000,
  },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-provider-"));
    const build = join(temp, "dist");
    const agentDir = join(temp, "agent");
    const extension = join(temp, "provider.ts");
    let client: RpcClient | undefined;
    try {
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      mkdirSync(agentDir);
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ retry: { enabled: false, baseDelayMs: 1 } }),
      );
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            fake: {
              baseUrl: "http://127.0.0.1:1/v1",
              api: "openai-completions",
              apiKey: "fake-key",
              models: [
                {
                  id: "fake-model",
                  name: "Fake Model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
      );
      writeFileSync(
        extension,
        `
      import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";

      export default function(pi) {
        let retryFailed = false;
        let contextAction;
        pi.on("before_agent_start", ({ prompt, systemPromptOptions }) => {
          contextAction = prompt;
          if (prompt === "ORIGINAL-PROVIDER-QUESTION") {
            return { message: { customType: "input-probe", content: "ORIGINAL-CUSTOM-CONTENT", display: false } };
          }
          if (prompt === "CHECK-STRUCTURED-PROMPT") {
            systemPromptOptions.selectedTools = ["read"];
            systemPromptOptions.toolSnippets.read = "Customized read";
            systemPromptOptions.promptGuidelines.push("Fixture guideline");
            systemPromptOptions.sections.fixture = "Durable fixture section";
          }
          if (prompt === "CHECK-SYSTEM-END") {
            systemPromptOptions.selectedTools = ["read", "bash"];
            systemPromptOptions.sections["fixture-edit"] = "Original system section";
            systemPromptOptions.sections["fixture-drop"] = "Omitted system section";
          }
          if (prompt === "CHECK-CONTEXT-GROUP") {
            systemPromptOptions.selectedTools = ["read"];
            systemPromptOptions.sections["group-first"] = "Original grouped section";
            systemPromptOptions.sections["group-second"] = "Second grouped section";
          }
          if (prompt === "CHECK-CONTEXT-DROP") {
            systemPromptOptions.selectedTools = ["read", "bash"];
            systemPromptOptions.sections["drop-first"] = "First dropped section";
            systemPromptOptions.sections["drop-second"] = "Second dropped section";
          }
          if (prompt === "DISCARDED-BOUNDARY-PROMPT") {
            systemPromptOptions.sections["compaction-first"] = "First retained section";
            systemPromptOptions.sections["compaction-second"] = "Second retained section";
          }
          if (prompt === "CHECK-FORCED-PROMPT") return { systemPrompt: "Opaque fixture override" };
        });
        pi.on("context_with_system", ({ messages }) => {
          if (contextAction === "CHECK-CONTEXT-GROUP") {
            return { messages: messages.map((message) => {
              if (message.role !== "system" || !message.sections?.["group-first"] ||
                  !message.sections?.["group-second"]) return message;
              return { ...message, sections: { ...message.sections, "group-first": "Request-only grouped section" } };
            }) };
          }
          if (contextAction === "CHECK-CONTEXT-DROP") {
            return { messages: messages.filter((message) =>
              message.role !== "system" || !message.sections?.["drop-first"] ||
              !message.sections?.["drop-second"]) };
          }
          const [head, summary, ...tail] = messages;
          if (contextAction === "DISCARDED-BOUNDARY-PROMPT" && summary?.role === "compactionSummary" &&
              head?.role === "system" && head.sections?.["compaction-first"] && head.sections?.["compaction-second"]) {
            return { messages: [{
              ...head, sections: { ...head.sections, "compaction-first": "PROJECTED-COMPACTED-PROMPT" },
            }, summary, ...tail] };
          }
        });
        pi.on("message_end", async ({ message }) => {
          if (message.role === "system" && message.sections?.["fixture-edit"]) {
            await Promise.resolve();
            const { "fixture-drop": omitted, ...sections } = message.sections;
            return { message: { ...message,
              sections: { ...sections, "fixture-edit": "Edited system section" },
              toolsAdded: message.toolsAdded?.filter(({ name }) => name !== "bash"),
              toolsRemoved: [...(message.toolsRemoved ?? []), { name: "bash" }],
            } };
          }
          if (message.role === "user" && message.content[0]?.text === "ORIGINAL-PROVIDER-QUESTION") {
            await Promise.resolve();
            return { message: { ...message, content: "HARNESS-PROVIDER-QUESTION" } };
          }
          if (message.role === "custom" && message.customType === "input-probe") {
            return { message: { ...message, content: "HARNESS-CUSTOM-CONTENT", details: { edited: true } } };
          }
          if (message.role === "assistant" && message.content[0]?.text === "RAW-LIFECYCLE-MESSAGE") {
            return { message: { ...message, content: [{ type: "text", text: "EDITED-LIFECYCLE-MESSAGE" }] } };
          }
        });
        pi.on("turn_end", ({ message, messageEntryId, turnIndex }, ctx) => {
          if (message.content[0]?.text === "DISCARDED-BOUNDARY-REPLY") {
            return {
              continue: true,
              entries: [{ type: "compaction", summary: "BOUNDARY-HANDOFF", firstKeptEntryId: null }],
            };
          }
          if (message.content[0]?.text === "ERASE-THIS-REPLY") {
            const user = ctx.sessionManager.getBranch().findLast((entry) =>
              entry.type === "message" && entry.message.role === "user");
            return {
              continue: true,
              entries: [
                { type: "context_edit", targetId: user.id, replacement: { content: "EDITED-USER-CONTENT" } },
                { type: "context_edit", targetId: messageEntryId, replacement: null },
              ],
            };
          }
          if (message.content[0]?.text !== "EDITED-LIFECYCLE-MESSAGE") return;
          const committed = ctx.sessionManager.getEntry(messageEntryId)?.message.content[0]?.text;
          return {
            entries: [{ type: "custom", customType: "lifecycle-record", data: { committed, turnIndex } }],
          };
        });
        pi.on("agent_before_settle", ({ context }) => {
          const last = context.llmMessages.at(-1);
          if (last?.role !== "assistant" || last.content[0]?.text !== "EDITED-LIFECYCLE-MESSAGE") return;
          return {
            continue: true,
            entries: [{ type: "custom_message", customType: "settlement-fixture", display: false,
              content: "CONTINUE-LIFECYCLE" }],
          };
        });
        pi.registerTool({
          name: "nested_probe", label: "Nested probe", description: "Echo a nested argument.",
          exposure: "deferred",
          parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          async execute(_id, { value }) {
            return { content: [{ type: "text", text: value }], details: {} };
          },
        });
        pi.registerTool({
          name: "parent_probe", label: "Parent probe", description: "Call the deferred probe.",
          parameters: { type: "object", properties: {} },
          prepareLoadout() {
            if (contextAction === "HARNESS-HIDDEN-TOOL") return { hiddenDeclarations: ["read"] };
          },
          async execute(_id, _args, _signal, _update, ctx) {
            return (await ctx.executeTool("nested_probe", { value: "ORIGINAL" })).result;
          },
        });
        pi.on("tool_call", (event) => {
          if (event.toolName === "nested_probe" && event.parentToolCallId === "outer-probe") {
            event.input.value = "REWRITTEN-NESTED-ARGUMENT";
          }
        });
        pi.registerProvider("extension-probe", {
          baseUrl: "http://127.0.0.1:1",
          api: "probe-stream",
          apiKey: "fixture-only",
          models: [{
            id: "fixture",
            name: "Extension fixture",
            input: ["text"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 20000,
            maxTokens: 1000,
          }],
          streamSimple(model, context) {
            const stream = createAssistantMessageEventStream();
            const last = context.messages.at(-1);
            const conversation = JSON.stringify(context.messages);
            const retryProbe = JSON.stringify(last).includes("AUTO_RETRY_PROBE");
            const hasEdit = conversation.includes("EDITED-USER-CONTENT") &&
              !conversation.includes("ORIGINAL-USER-CONTENT") && !conversation.includes("ERASE-THIS-REPLY");
            const checksPrompt = last?.role === "user" && JSON.stringify(last).includes("CHECK-");
            const text = retryProbe ? conversation.includes("RETRY-DISCARD") ? "RETRY-LEAKED" : "RETRY-OK"
              : checksPrompt ? JSON.stringify({
              system: context.systemPrompt ?? getSystemMessageText(getCurrentSystemMessage(context.messages)),
              tools: getCurrentTools(context.messages).map(({ name }) => name),
            }) : JSON.stringify(last).includes("CONTINUE-LIFECYCLE") ? "SETTLED-LIFECYCLE-MESSAGE"
              : JSON.stringify(last).includes("CHECK_LIFECYCLE") ? "RAW-LIFECYCLE-MESSAGE"
              : JSON.stringify(last).includes("DISCARDED-BOUNDARY-PROMPT") ? "DISCARDED-BOUNDARY-REPLY"
              : conversation.includes("BOUNDARY-HANDOFF") && conversation.includes("PROJECTED-COMPACTED-PROMPT") &&
                !conversation.includes("DISCARDED-BOUNDARY-")
                ? "BOUNDARY-COMPACTED"
              : JSON.stringify(last).includes("ORIGINAL-USER-CONTENT") ? "ERASE-THIS-REPLY"
              : JSON.stringify(last).includes("EDITED-USER-CONTENT") || JSON.stringify(last).includes("INSPECT_CONTEXT_EDIT")
                ? hasEdit ? "CONTEXT-EDIT-APPLIED" : "CONTEXT-EDIT-MISSING"
              : last?.role === "toolResult" ? last.content[0].text
              : conversation.includes("HARNESS-PROVIDER-QUESTION") && conversation.includes("HARNESS-CUSTOM-CONTENT") &&
                !conversation.includes("ORIGINAL-PROVIDER-QUESTION") && !conversation.includes("ORIGINAL-CUSTOM-CONTENT")
                ? "HARNESS-PROVIDER-ANSWER" : "MISSING-QUESTION";
            const partial = {
              role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
              stopReason: "stop", timestamp: Date.now(),
              usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            stream.push({ type: "start", partial });
            if (retryProbe && !retryFailed) {
              retryFailed = true;
              stream.push({ type: "error", reason: "error", error: {
                ...partial, content: [{ type: "text", text: "RETRY-DISCARD" }],
                stopReason: "error", errorMessage: "overloaded_error",
              } });
              stream.end();
              return stream;
            }
            if (last?.role === "user" && JSON.stringify(last).includes("HARNESS-NESTED-QUESTION")) {
              stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse",
                content: [{ type: "toolCall", id: "outer-probe", name: "parent_probe", arguments: {} }] } });
              stream.end();
              return stream;
            }
            if (last?.role === "user" && JSON.stringify(last).includes("HARNESS-HIDDEN-TOOL") &&
                !getCurrentTools(context.messages).some(({ name }) => name === "read")) {
              stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse",
                content: [{ type: "toolCall", id: "hidden-probe", name: "read", arguments: { path: "probe.txt" } }] } });
              stream.end();
              return stream;
            }
            if (last?.role === "user" && JSON.stringify(last).includes("HARNESS-DIRECT-DEFERRED")) {
              stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse",
                content: [{ type: "toolCall", id: "direct-probe", name: "nested_probe", arguments: { value: "DIRECT" } }] } });
              stream.end();
              return stream;
            }
            partial.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: 0, partial });
            partial.content[0].text = text;
            stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
            stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
            stream.push({ type: "done", reason: "stop", message: partial });
            stream.end();
            return stream;
          },
        });
      }
    `,
      );
      execFileSync("pnpm", [
        "--filter",
        "@harness/pi-coding-agent-cli",
        "build",
        "--outDir",
        build,
      ]);
      const rpc = new RpcClient({
        cliPath: join(build, "cli.js"),
        cwd: temp,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
        args: ["--no-session", "--approve", "--model", "extension-probe/fixture", "-e", extension],
      });
      client = rpc;
      await rpc.start();
      expect((await rpc.getState()).model?.provider).toBe("extension-probe");
      expect(await rpc.getAvailableModels()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "fixture",
            api: "probe-stream",
            provider: "extension-probe",
          }),
        ]),
      );

      const [, disposition] = await Promise.all([
        rpc.waitForIdle(15_000),
        rpc.prompt("ORIGINAL-PROVIDER-QUESTION"),
      ]);
      expect(disposition).toBe("started");
      expect(await rpc.getLastAssistantText()).toBe("HARNESS-PROVIDER-ANSWER");
      const { entries } = await rpc.getEntries();
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "assistant",
              api: "probe-stream",
              usage: expect.objectContaining({ input: 7 }),
            }),
          }),
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "HARNESS-PROVIDER-QUESTION",
            }),
          }),
          expect.objectContaining({
            type: "custom_message",
            customType: "input-probe",
            content: "HARNESS-CUSTOM-CONTENT",
            details: { edited: true },
          }),
        ]),
      );
      const [, nestedDisposition] = await Promise.all([
        rpc.waitForIdle(15_000),
        rpc.prompt("HARNESS-NESTED-QUESTION"),
      ]);
      expect(nestedDisposition).toBe("started");
      expect(await rpc.getLastAssistantText()).toBe("REWRITTEN-NESTED-ARGUMENT");
      const toolEntries = (await rpc.getEntries()).entries.filter(
        (entry) => entry.type === "message" && entry.message.role === "toolResult",
      );
      expect(toolEntries).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({
            toolCallId: "outer-probe",
            nestedCalls: expect.objectContaining({
              calls: [expect.objectContaining({ id: "outer-probe/1", name: "nested_probe" })],
            }),
          }),
        }),
      ]);

      writeFileSync(join(temp, "probe.txt"), "HIDDEN-READ-CONTENT");
      await Promise.all([rpc.waitForIdle(15_000), rpc.prompt("HARNESS-HIDDEN-TOOL")]);
      expect(await rpc.getLastAssistantText()).toContain("HIDDEN-READ-CONTENT");
      await Promise.all([rpc.waitForIdle(15_000), rpc.prompt("HARNESS-DIRECT-DEFERRED")]);
      expect(await rpc.getLastAssistantText()).toBe("Tool nested_probe not found");

      async function checkPrompt(prompt: string): Promise<{ system: string; tools: string[] }> {
        const [, disposition] = await Promise.all([rpc.waitForIdle(15_000), rpc.prompt(prompt)]);
        expect(disposition).toBe("started");
        return JSON.parse((await rpc.getLastAssistantText())!);
      }
      const edited = await checkPrompt("CHECK-STRUCTURED-PROMPT");
      expect(edited.tools).toEqual(["read"]);
      expect(edited.system).toContain("- read: Customized read");
      expect(edited.system).toContain("Fixture guideline");
      expect(edited.system).toContain("Durable fixture section");

      const forced = await checkPrompt("CHECK-FORCED-PROMPT");
      expect(forced).toEqual({ system: "Opaque fixture override", tools: ["read"] });
      const reverted = await checkPrompt("CHECK-BASE-PROMPT");
      expect(reverted.system).toContain("- read: Read file contents");
      expect(reverted.system).not.toContain("Durable fixture section");
      const promptEntries = (await rpc.getEntries()).entries.filter(
        (entry) => entry.type === "message" && entry.message.role === "system",
      );
      expect(JSON.stringify(promptEntries)).toContain('"fixture":null');
      expect(JSON.stringify(promptEntries)).not.toContain("Opaque fixture override");

      const editedSystem = await checkPrompt("CHECK-SYSTEM-END");
      expect(editedSystem.system).toContain("Edited system section");
      expect(editedSystem.system).not.toContain("Original system section");
      expect(editedSystem.system).not.toContain("Omitted system section");
      expect(editedSystem.tools).toEqual(["read", "bash"]);
      expect((await rpc.getEntries()).entries).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "system",
            sections: expect.objectContaining({ "fixture-edit": "Edited system section" }),
            toolsRemoved: expect.arrayContaining([{ name: "bash" }]),
          }),
        }),
      );

      const groupedContext = await checkPrompt("CHECK-CONTEXT-GROUP");
      expect(groupedContext.system).toContain("Request-only grouped section");
      expect(groupedContext.system).toContain("Second grouped section");
      expect(groupedContext.system).not.toContain("Original grouped section");
      const droppedContext = await checkPrompt("CHECK-CONTEXT-DROP");
      expect(droppedContext.system).not.toContain("First dropped section");
      expect(droppedContext.system).not.toContain("Second dropped section");
      expect(droppedContext.tools).toEqual(["read"]);
      const rawGroups = JSON.stringify((await rpc.getEntries()).entries);
      expect(rawGroups).toContain("Original grouped section");
      expect(rawGroups).toContain("First dropped section");
      expect(rawGroups).not.toContain("Request-only grouped section");

      const [, lifecycle] = await Promise.all([
        rpc.waitForIdle(15_000),
        rpc.prompt("CHECK_LIFECYCLE"),
      ]);
      expect(lifecycle).toBe("started");
      expect(await rpc.getLastAssistantText()).toBe("SETTLED-LIFECYCLE-MESSAGE");
      expect((await rpc.getEntries()).entries).toContainEqual(
        expect.objectContaining({
          type: "custom",
          customType: "lifecycle-record",
          data: { committed: "EDITED-LIFECYCLE-MESSAGE", turnIndex: 0 },
        }),
      );

      await Promise.all([rpc.waitForIdle(15_000), rpc.prompt("ORIGINAL-USER-CONTENT")]);
      expect(await rpc.getLastAssistantText()).toBe("CONTEXT-EDIT-APPLIED");
      const editEntries = (await rpc.getEntries()).entries;
      expect(editEntries.filter(({ type }) => type === "context_edit")).toEqual([
        expect.objectContaining({ replacement: { content: "EDITED-USER-CONTENT" } }),
        expect.objectContaining({ replacement: null }),
      ]);
      expect(JSON.stringify(editEntries)).toContain("ORIGINAL-USER-CONTENT");
      expect(JSON.stringify(editEntries)).toContain("ERASE-THIS-REPLY");
      await Promise.all([rpc.waitForIdle(15_000), rpc.prompt("INSPECT_CONTEXT_EDIT")]);
      expect(await rpc.getLastAssistantText()).toBe("CONTEXT-EDIT-APPLIED");

      await Promise.all([rpc.waitForIdle(15_000), rpc.prompt("DISCARDED-BOUNDARY-PROMPT")]);
      expect(await rpc.getLastAssistantText()).toBe("BOUNDARY-COMPACTED");
      const compacted = (await rpc.getEntries()).entries.find(({ type }) => type === "compaction");
      expect(compacted).toMatchObject({
        summary: "BOUNDARY-HANDOFF",
        firstKeptEntryId: compacted?.id,
        fromHook: true,
      });

      await rpc.setAutoRetry(true);
      const retryEvents: string[] = [];
      const unsubscribe = rpc.onEvent((event) => {
        if (event.type === "agent_end") retryEvents.push(`end:${event.willRetry}`);
        if (event.type === "auto_retry_start") retryEvents.push(`retry:${event.attempt}`);
        if (event.type === "auto_retry_end") retryEvents.push(`retry-end:${event.success}`);
      });
      await Promise.all([rpc.waitForIdle(15_000), rpc.prompt("AUTO_RETRY_PROBE")]);
      unsubscribe();
      expect(await rpc.getLastAssistantText()).toBe("RETRY-OK");
      expect(retryEvents).toEqual(["end:true", "retry:1", "retry-end:true", "end:false"]);
      const retryEntries = (await rpc.getEntries()).entries;
      const failure = retryEntries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason === "error",
      );
      expect(failure).toBeDefined();
      expect(retryEntries).toContainEqual(
        expect.objectContaining({
          type: "context_edit",
          targetId: failure?.id,
          replacement: null,
        }),
      );

      writeFileSync(extension, "export default function() {}");
      await rpc.newSession();
      expect(
        (await rpc.getAvailableModels()).some((model) => model.provider === "extension-probe"),
      ).toBe(false);
      expect((await rpc.getState()).model?.provider).toBe("fake");
    } finally {
      await client?.stop();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
