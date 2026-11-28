import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "keeps an in-memory session and its clone usable across scope replacement",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-session-replacement-"));
    const build = join(temp, "dist");
    const client = new RpcClient({
      cliPath: join(build, "cli.js"),
      cwd: temp,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent") },
      model: "deepseek-flash",
      args: ["--no-session", "--no-extensions"],
    });

    try {
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      execFileSync("pnpm", [
        "--filter",
        "@harness/pi-coding-agent-cli",
        "build",
        "--outDir",
        build,
      ]);
      await client.start();
      const originalId = (await client.getState()).sessionId;
      expect((await client.bash('node -p "13 * 17"')).output).toContain("221");
      await client.setSessionName("Original session");
      await client.setModel("deepseek", "deepseek-v4-pro");
      await client.setThinkingLevel("off");
      expect(await client.clone()).toEqual({ cancelled: false });
      expect((await client.getState()).sessionId).not.toBe(originalId);
      expect((await client.bash('node -p "17 * 19"')).output).toContain("323");
      expect(await client.switchSession(originalId)).toEqual({ cancelled: false });
      expect(await client.getState()).toMatchObject({
        sessionName: "Original session",
        model: { id: "deepseek-v4-pro" },
        thinkingLevel: "off",
      });
      const history = await client.getMessages();
      expect(history).toMatchObject([
        { role: "bashExecution", output: expect.stringContaining("221") },
      ]);
      expect(client.getStderr()).not.toContain("has been disposed");
    } finally {
      await client.stop();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

it(
  "leaves the active session in place when RPC resumes a session with a missing directory",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-missing-cwd-"));
    const build = join(temp, "dist");
    const originalCwd = join(temp, "original");
    const env = { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), PI_OFFLINE: "1" };
    const cliPath = join(build, "cli.js");
    const args = ["--no-extensions", "--model", "deepseek-flash"];
    const original = new RpcClient({ cliPath, cwd: originalCwd, env, args });
    const fromAnotherFolder = new RpcClient({ cliPath, cwd: temp, env, args });
    try {
      mkdirSync(originalCwd);
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      execFileSync("pnpm", [
        "--filter",
        "@harness/pi-coding-agent-cli",
        "build",
        "--outDir",
        build,
      ]);
      await original.start();
      await original.bash("pwd");
      const originalId = (await original.getState()).sessionId;
      await original.stop();
      renameSync(originalCwd, join(temp, "moved"));

      await fromAnotherFolder.start();
      const activeId = (await fromAnotherFolder.getState()).sessionId;
      await expect(fromAnotherFolder.switchSession(originalId)).rejects.toThrow(
        `Stored session working directory does not exist: ${originalCwd}`,
      );
      expect((await fromAnotherFolder.getState()).sessionId).toBe(activeId);

      const startup = spawnSync(
        process.execPath,
        [cliPath, ...args, "--session", originalId, "--mode", "rpc"],
        { cwd: temp, env, encoding: "utf8", timeout: 15_000 },
      );
      expect(startup.status).toBe(1);
      expect(startup.stderr).toContain(
        `Stored session working directory does not exist: ${originalCwd}`,
      );
      expect(startup.stderr).toContain(`Current working directory: ${temp}`);
    } finally {
      await original.stop();
      await fromAnotherFolder.stop();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
