import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it("keeps the current model and thinking level when a new session starts", { timeout: 60_000 }, async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(artifacts, "pi-cli-session-model-"));
  const build = join(temp, "dist");
  const agentDir = join(temp, "agent");
  const extension = join(temp, "provider.ts");
  let client: RpcClient | undefined;
  try {
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(temp, "node_modules"), "junction");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, baseDelayMs: 1 } }));
    writeFileSync(extension, `
      import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

      export default function(pi) {
        pi.registerProvider("session-model-probe", {
          baseUrl: "http://127.0.0.1:1",
          api: "probe-stream",
          apiKey: "fixture-only",
          models: [{
            id: "fixture",
            name: "Session model fixture",
            input: ["text"],
            reasoning: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 1000,
          }],
          streamSimple(model) {
            const stream = createAssistantMessageEventStream();
            const partial = {
              role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
              stopReason: "stop", timestamp: Date.now(),
              usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            stream.push({ type: "start", partial });
            partial.content.push({ type: "text", text: "MODEL-REPLY" });
            stream.push({ type: "text_start", contentIndex: 0, partial });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "MODEL-REPLY", partial });
            stream.push({ type: "text_end", contentIndex: 0, content: "MODEL-REPLY", partial });
            stream.push({ type: "done", reason: "stop", message: partial });
            stream.end();
            return stream;
          },
        });
      }
    `);
    execFileSync("pnpm", ["--filter", "@harness/pi-coding-agent-cli", "build", "--outDir", build]);
    client = new RpcClient({
      cliPath: join(build, "cli.js"),
      cwd: temp,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      args: ["--no-session", "--approve", "--model", "session-model-probe/fixture", "-e", extension],
    });
    await client.start();
    expect((await client.getState()).model).toMatchObject({ provider: "session-model-probe", id: "fixture" });

    const [, disposition] = await Promise.all([client.waitForIdle(15_000), client.prompt("KEEP-MODEL")]);
    expect(disposition).toBe("started");
    expect(await client.getLastAssistantText()).toBe("MODEL-REPLY");
    const before = await client.getState();
    expect(before.model).toMatchObject({ provider: "session-model-probe", id: "fixture" });

    expect(await client.newSession()).toEqual({ cancelled: false });
    const after = await client.getState();
    expect(after.sessionId).not.toBe(before.sessionId);
    expect(after.messageCount).toBe(0);
    expect(after.model).toMatchObject({ provider: before.model!.provider, id: before.model!.id });
    expect(after.thinkingLevel).toBe(before.thinkingLevel);
  } finally {
    await client?.stop();
    rmSync(temp, { recursive: true, force: true });
  }
});
