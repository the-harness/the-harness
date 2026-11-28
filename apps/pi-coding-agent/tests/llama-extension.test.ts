import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it("lists the built-in llama.cpp extension command over RPC", { timeout: 60_000 }, async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(artifacts, "pi-cli-llama-"));
  const build = join(temp, "dist");
  const agentDir = join(temp, "agent");
  let client: RpcClient | undefined;
  try {
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(temp, "node_modules"), "junction");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        fake: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "fake-key",
          authHeader: true,
          models: [{
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            contextWindow: 200_000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }));
    execFileSync("pnpm", ["--filter", "@harness/pi-coding-agent-cli", "build", "--outDir", build]);
    const rpc = new RpcClient({
      cliPath: join(build, "cli.js"),
      cwd: temp,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      model: "fake/fake-model",
      args: ["--no-session", "--approve"],
    });
    client = rpc;
    await rpc.start();
    const commands = await rpc.getCommands();
    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({
      name: "llama",
      description: "Manage llama.cpp router models",
      source: "extension",
    })]));
  } finally {
    await client?.stop();
    rmSync(temp, { recursive: true, force: true });
  }
});
