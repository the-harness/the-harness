import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "routes virtual turns with branch state and the failed physical request",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-virtual-model-"));
    const agent = join(temp, "agent");
    const build = join(temp, "dist");
    const extension = join(temp, "router.ts");
    const log = join(temp, "routes.jsonl");

    try {
      mkdirSync(agent);
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      writeFileSync(
        join(agent, "settings.json"),
        JSON.stringify({
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
          compaction: { enabled: false },
        }),
      );
      writeFileSync(
        extension,
        `
      import { appendFileSync } from "node:fs";
      import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
      export default function(pi) {
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        pi.registerProvider("virtual-physical", {
          baseUrl: "http://127.0.0.1:1", api: "virtual-physical", apiKey: "fixture",
          models: ["primary", "backup"].map(id => ({
            id, name: id, input: ["text"], reasoning: false, contextWindow: 100000, maxTokens: 1000, cost,
          })),
          streamSimple(model, context) {
            const stream = createAssistantMessageEventStream();
            const reply = {
              role: "assistant", model: model.id, provider: model.provider, api: model.api,
              timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: model.id }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
            };
            const user = context.messages.findLast(message => message.role === "user");
            if (model.id === "primary" && JSON.stringify(user).includes("RETRY-VIRTUAL")) {
              stream.push({ type: "error", reason: "error",
                error: { ...reply, stopReason: "error", errorMessage: "overloaded_error", content: [] } });
            } else {
              stream.push({ type: "done", reason: "stop", message: reply });
            }
            stream.end();
            return stream;
          },
        });
        pi.registerVirtualModel({
          provider: "virtual-selection", id: "auto", name: "Auto",
          route({ reason, state, failed, previous, messages }) {
            appendFileSync(${JSON.stringify(log)}, JSON.stringify({
              reason, state, failed: failed?.model.id, previous: previous?.model.id,
              leakedFailure: messages.some(message => message.role === "assistant" && message.stopReason === "error"),
            }) + "\\n");
            return {
              model: { provider: "virtual-physical", id: reason === "retry" ? "backup" : "primary" },
              thinkingLevel: "off", state: (state ?? 0) + 1,
            };
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
      async function session(args: string[], run: (rpc: RpcClient) => Promise<void>) {
        const rpc = new RpcClient({
          cliPath: join(build, "cli.js"),
          cwd: temp,
          env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
          args: [
            "--approve",
            "--no-tools",
            "--no-context-files",
            "--no-skills",
            "-e",
            extension,
            ...args,
          ],
        });
        try {
          await rpc.start();
          await run(rpc);
        } finally {
          await rpc.stop();
        }
      }
      const turn = (rpc: RpcClient, text: string) =>
        Promise.all([rpc.waitForIdle(15_000), rpc.prompt(text)]);
      const states = async (rpc: RpcClient) =>
        (await rpc.getEntries()).entries.flatMap((entry) =>
          entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY
            ? [(entry.data as { state: number }).state]
            : [],
        );

      let entryId: string | undefined;
      await session(["--model", "virtual-selection/auto"], async (rpc) => {
        await turn(rpc, "BEFORE-RETRY");
        await turn(rpc, "RETRY-VIRTUAL");
        expect(await rpc.getLastAssistantText()).toBe("backup");
        expect((await rpc.getState()).model?.id).toBe("auto");
        expect(await states(rpc)).toEqual([1, 2, 3]);
        entryId = (await rpc.getForkMessages()).find(
          ({ text }) => text === "RETRY-VIRTUAL",
        )?.entryId;
      });
      await session(["--continue"], async (rpc) => {
        expect((await rpc.getState()).model?.id).toBe("auto");
        await turn(rpc, "AFTER-RESTART");
        expect(await states(rpc)).toEqual([1, 2, 3, 4]);
        if (!entryId) throw new Error("Expected the original fork entry ID");
        expect((await rpc.fork(entryId)).cancelled).toBe(false);
        expect(await states(rpc)).toEqual([1]);
        await turn(rpc, "AFTER-FORK");
        expect(await states(rpc)).toEqual([1, 2]);
      });
      const requests = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row));
      expect(requests).toEqual([
        { reason: "user", leakedFailure: false },
        { reason: "user", state: 1, previous: "primary", leakedFailure: false },
        { reason: "retry", state: 2, previous: "primary", failed: "primary", leakedFailure: false },
        { reason: "user", state: 3, previous: "backup", leakedFailure: false },
        { reason: "user", state: 1, previous: "primary", leakedFailure: false },
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

it(
  "routes through the native DeepSeek provider alongside its virtual models",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-native-virtual-"));
    const agent = join(temp, "agent");
    const build = join(temp, "dist");
    const extension = join(temp, "router.ts");
    const requests: {
      model: string;
      system: unknown;
      messages: { role: string; content: unknown }[];
    }[] = [];
    let rpc: RpcClient | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_native",
            model: "deepseek-flash",
            role: "assistant",
            content: [],
            usage: { input_tokens: 15, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "NATIVE-REPLY" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a fixture port");
      mkdirSync(agent);
      writeFileSync(
        join(agent, "settings.json"),
        JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1 } }),
      );
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      writeFileSync(
        extension,
        `
      export default function(pi) {
        pi.registerVirtualModel({
          provider: "deepseek", id: "native-router", name: "Native router",
          route({ state }) {
            return { model: { provider: "deepseek", id: "deepseek-flash" }, thinkingLevel: "off",
              state: (state ?? 0) + 1 };
          },
        });
        pi.on("before_agent_start", ({ prompt, systemPromptOptions }) => {
          systemPromptOptions.sections.fixture = "NATIVE-PROMPT-" + prompt;
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
      rpc = new RpcClient({
        cliPath: join(build, "cli.js"),
        cwd: temp,
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: agent,
          DEEPSEEK_API_KEY: "fixture",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
        args: [
          "--approve",
          "--no-tools",
          "--no-context-files",
          "--no-skills",
          "--model",
          "deepseek/native-router",
          "-e",
          extension,
        ],
      });
      await rpc.start();
      expect(
        (await rpc.getAvailableModels())
          .filter(({ provider }) => provider === "deepseek")
          .map(({ id }) => id),
      ).toEqual(expect.arrayContaining(["deepseek-flash", "native-router"]));
      for (const prompt of ["FIRST", "SECOND"]) {
        await Promise.all([rpc.waitForIdle(15_000), rpc.prompt(prompt)]);
        expect(await rpc.getLastAssistantText()).toBe("NATIVE-REPLY");
      }
      expect((await rpc.getState()).model?.id).toBe("native-router");
      expect(JSON.stringify(requests[1]?.system)).toContain("NATIVE-PROMPT-FIRST");
      const update = requests[1]?.messages.find(({ role }) => role === "system");
      expect(JSON.stringify(update)).toContain("NATIVE-PROMPT-SECOND");
      expect((await rpc.compact("Summarize the native route fixture")).summary).toBe(
        "NATIVE-REPLY",
      );
      expect(requests.map(({ model }) => model)).toEqual([
        "deepseek-flash",
        "deepseek-flash",
        "deepseek-flash",
      ]);
      expect(
        (await rpc.getEntries()).entries.flatMap((entry) =>
          entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY
            ? [(entry.data as { state: number }).state]
            : [],
        ),
      ).toEqual([1, 2]);
    } finally {
      await rpc?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
