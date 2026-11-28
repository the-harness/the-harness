import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it("stores the session database in the configured session directory", { timeout: 60_000 }, async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(artifacts, "pi-cli-session-dir-"));
  const build = join(temp, "dist");
  const agent = join(temp, "agent");
  const cwd = join(temp, "project");
  mkdirSync(agent);
  mkdirSync(cwd);
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(temp, "node_modules"), "junction");
  execFileSync("pnpm", ["--filter", "@harness/pi-coding-agent-cli", "build", "--outDir", build]);
  writeFileSync(join(agent, "models.json"), JSON.stringify({
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
  }));
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
  };
  async function openSessionFile(settings: object, args: string[]): Promise<string | undefined> {
    writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
    const client = new RpcClient({
      cliPath: join(build, "cli.js"),
      cwd,
      env,
      model: "fake/fake-model",
      args: ["--offline", "--approve", ...args],
    });
    try {
      await client.start();
      const state = await client.getState();
      return state.sessionFile;
    } finally {
      await client.stop();
    }
  }

  try {
    const configured = join(temp, "configured-sessions");
    expect(await openSessionFile({ sessionDir: configured }, [])).toBe(join(configured, "harness.sqlite"));
    expect(existsSync(join(configured, "harness.sqlite"))).toBe(true);
    expect(existsSync(join(agent, "sessions"))).toBe(false);

    const flag = join(temp, "flag-sessions");
    expect(await openSessionFile({ sessionDir: join(temp, "ignored-sessions") }, ["--session-dir", flag]))
      .toBe(join(flag, "harness.sqlite"));
    expect(existsSync(join(temp, "ignored-sessions", "harness.sqlite"))).toBe(false);

    expect(await openSessionFile({ sessionDir: "relative-sessions" }, []))
      .toBe(join(cwd, "relative-sessions", "harness.sqlite"));
    expect(existsSync(join(cwd, "relative-sessions", "harness.sqlite"))).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
