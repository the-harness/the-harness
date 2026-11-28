import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it.skipIf(process.platform === "win32")(
  "exposes the Pi process markers and resolves bash to /bin/bash",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-env-"));
    const agentDir = join(temp, "agent");
    const build = join(temp, "dist");
    // A local provider with its own credentials keeps model resolution independent of
    // ambient API keys and of whether built-in providers are configured.
    mkdirSync(agentDir, { recursive: true });
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
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }, null, 2));
    const client = new RpcClient({
      cliPath: join(build, "cli.js"),
      cwd: temp,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      model: "fake/fake-model",
      args: ["--no-session", "--no-approve", "--no-extensions"],
    });
    try {
      symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(temp, "node_modules"), "junction");
      execFileSync("pnpm", ["--filter", "@harness/pi-coding-agent-cli", "build", "--outDir", build]);
      await client.start();

      const env = await client.bash(`printf '%s|%s' "$AI_AGENT" "$PI_CODING_AGENT"`);
      expect(env).toMatchObject({ output: "pi|true", exitCode: 0, cancelled: false });

      const missing = await client.bash("definitely-not-a-command");
      expect(missing).toMatchObject({ exitCode: 127, cancelled: false });
      expect(missing.output).toContain(
        `${existsSync("/bin/bash") ? "/bin/bash" : "bash"}: definitely-not-a-command: command not found`,
      );
    } finally {
      await client.stop();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
