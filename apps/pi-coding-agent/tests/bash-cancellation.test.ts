import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it.skipIf(process.platform === "win32")(
  "cancels a local Bash command without waiting for a descendant holding its output pipe",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-bash-cancel-"));
    const build = join(temp, "dist");
    const client = new RpcClient({
      cliPath: join(build, "cli.js"),
      cwd: temp,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent") },
      model: "deepseek-flash",
      args: ["--no-session", "--no-approve", "--no-extensions"],
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
      const ready = Promise.withResolvers<void>();
      const unsubscribe = client.onEvent((event) => {
        if (event.type === "bash_execution_update" && event.delta.includes("PIPE-READY"))
          ready.resolve();
      });
      const pending = client.bash("sleep 8 & printf PIPE-READY; wait");
      void pending.catch(ready.reject);
      try {
        await Promise.race([
          ready.promise,
          setTimeout(4_000, undefined, { ref: false }).then(() => {
            throw new Error("Bash did not start");
          }),
        ]);
        await client.abortBash();
        const result = await Promise.race([
          pending,
          setTimeout(3_000, undefined, { ref: false }).then(() => {
            throw new Error("Descendant kept Bash output open");
          }),
        ]);
        expect(result).toMatchObject({ output: "PIPE-READY", cancelled: true });
        expect(result.exitCode).toBeUndefined();
      } finally {
        unsubscribe();
        await pending.catch(() => {});
      }
    } finally {
      await client.stop();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
