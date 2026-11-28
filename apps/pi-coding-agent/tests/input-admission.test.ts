import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "keeps a cancelled Pi input batch out of durable Context while message edits are pending",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-input-admission-"));
    const build = join(temp, "dist");
    const extension = join(temp, "admission.ts");
    const waiting = join(temp, "waiting");
    const release = join(temp, "release");
    const sessions = join(temp, "sessions");
    const client = new RpcClient({
      cliPath: join(build, "cli.js"),
      cwd: temp,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "local-only",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:9",
        PI_CODING_AGENT_DIR: join(temp, "agent"),
      },
      model: "deepseek-flash",
      args: ["--offline", "--approve", "--session-dir", sessions, "-e", extension],
    });
    try {
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      writeFileSync(
        extension,
        `
      import { existsSync, writeFileSync } from "node:fs";
      import { setTimeout } from "node:timers/promises";
      export default function(pi) {
        pi.on("before_agent_start", () => ({
          message: { customType: "delayed-input", content: "DELAYED-INPUT-DRAFT", display: false },
        }));
        pi.on("message_end", async ({ message }) => {
          if (message.role === "user") {
            return { message: { ...message, content: [{ type: "text", text: "EDITED-INPUT-DRAFT" }] } };
          }
          if (message.role === "custom" && message.customType === "delayed-input") {
            writeFileSync(${JSON.stringify(waiting)}, "");
            while (!existsSync(${JSON.stringify(release)})) await setTimeout(10);
          }
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
      await client.start();
      expect(await client.prompt("ORIGINAL-INPUT-DRAFT")).toBe("started");
      const deadline = Date.now() + 10_000;
      while (!existsSync(waiting) && Date.now() < deadline) await delay(10);
      expect(existsSync(waiting)).toBe(true);

      const database = new DatabaseSync(join(sessions, "harness.sqlite"), { readOnly: true });
      try {
        const branches = database.prepare("SELECT state FROM tree_branches").all();
        expect(JSON.stringify(branches)).not.toMatch(/(?:ORIGINAL|EDITED|DELAYED)-INPUT-DRAFT/);
      } finally {
        database.close();
      }
      expect(JSON.stringify((await client.getEntries()).entries)).not.toMatch(
        /(?:ORIGINAL|EDITED|DELAYED)-INPUT-DRAFT/,
      );

      const idle = client.waitForIdle(10_000);
      const aborting = client.abort();
      await client.getState();
      writeFileSync(release, "");
      await Promise.all([aborting, idle]);
      expect(JSON.stringify((await client.getEntries()).entries)).not.toMatch(
        /(?:ORIGINAL|EDITED|DELAYED)-INPUT-DRAFT/,
      );
    } finally {
      writeFileSync(release, "");
      await client.stop();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
