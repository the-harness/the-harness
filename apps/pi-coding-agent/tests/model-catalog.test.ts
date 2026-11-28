import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "ZAI_API_KEY",
];

function isolatedEnv(agentDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  for (const key of PROVIDER_KEYS) delete env[key];
  return env;
}

it("only exposes models whose provider has configured credentials", { timeout: 60_000 }, async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(artifacts, "pi-cli-model-catalog-"));
  const agentDir = join(temp, "agent");
  const build = join(temp, "dist");
  try {
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(temp, "node_modules"), "junction");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        fake: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "fake-key",
          models: [{
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            contextWindow: 200_000,
            maxTokens: 8_192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }));
    execFileSync("pnpm", ["--filter", "@harness/pi-coding-agent-cli", "build", "--outDir", build]);
    async function session(args: string[], run: (rpc: RpcClient) => Promise<void>) {
      const rpc = new RpcClient({
        cliPath: join(build, "cli.js"), cwd: temp, env: isolatedEnv(agentDir),
        args: ["--no-session", "--approve", "--no-extensions", "--no-tools", "--no-context-files", "--no-skills", ...args],
      });
      try {
        await rpc.start();
        await run(rpc);
      } finally {
        await rpc.stop();
      }
    }

    await session([], async (rpc) => {
      const models = await rpc.getAvailableModels();
      expect(models.map(({ provider, id }) => `${provider}/${id}`)).toEqual(["fake/fake-model"]);
      expect((await rpc.getState()).model).toMatchObject({ provider: "fake", id: "fake-model" });
    });
    await session(["--models", "deepseek/deepseek-flash"], async (rpc) => {
      expect((await rpc.getAvailableModels()).some(({ provider }) => provider === "deepseek")).toBe(false);
      expect((await rpc.getState()).model).toMatchObject({ provider: "fake", id: "fake-model" });
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
