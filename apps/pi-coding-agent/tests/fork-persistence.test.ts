import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it("keeps an empty /fork out of the catalog and --continue", { timeout: 90_000 }, async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(artifacts, "pi-cli-fork-persistence-"));
  const build = join(temp, "dist");
  const agent = join(temp, "agent");
  const sessions = join(temp, "sessions");
  const database = join(sessions, "harness.sqlite");
  const extension = join(temp, "provider.ts");
  const clients: RpcClient[] = [];
  try {
    mkdirSync(agent);
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(temp, "node_modules"), "junction");
    writeFileSync(extension, `
      import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
      export default function (pi) {
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        pi.registerProvider("fork-persistence", {
          baseUrl: "http://127.0.0.1:1", apiKey: "local", api: "fork-persistence",
          models: [{ id: "echo", name: "Echo", input: ["text"], reasoning: false, cost,
            contextWindow: 100_000, maxTokens: 1_000 }],
          streamSimple(model) {
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "done", reason: "stop", message: {
              role: "assistant", provider: model.provider, api: model.api, model: model.id,
              timestamp: Date.now(), stopReason: "stop",
              usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { ...cost, total: 0 } },
              content: [{ type: "text", text: "REPLY-A" }],
            } });
            stream.end();
            return stream;
          },
        });
      }
    `);
    execFileSync("pnpm", ["--filter", "@harness/pi-coding-agent-cli", "build", "--outDir", build]);
    const options = {
      cliPath: join(build, "cli.js"),
      cwd: temp,
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
      args: [
        "--offline", "--approve", "--no-context-files", "-e", extension,
        "--session-dir", sessions, "--model", "fork-persistence/echo",
      ],
    };

    const parent = new RpcClient(options);
    clients.push(parent);
    await parent.start();
    const parentId = (await parent.getState()).sessionId;
    await parent.promptAndWait("MSG-A first");
    const [forkable] = await parent.getForkMessages();
    expect(await parent.fork(forkable!.entryId)).toMatchObject({ cancelled: false });
    expect((await parent.getState()).sessionId).not.toBe(parentId);
    expect((await parent.getEntries()).entries.filter((entry) => entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant"))).toEqual([]);
    await parent.stop();

    const read = new DatabaseSync(database, { readOnly: true });
    try {
      expect(read.prepare("SELECT id FROM pi_cli_sessions").all().map((row) => row.id)).toEqual([parentId]);
    } finally {
      read.close();
    }

    const continued = new RpcClient({ ...options, args: [...options.args, "--continue"] });
    clients.push(continued);
    await continued.start();
    expect((await continued.getState()).sessionId).toBe(parentId);
    expect(await continued.getLastAssistantText()).toBe("REPLY-A");
    await continued.stop();
  } finally {
    await Promise.allSettled(clients.map((client) => client.stop()));
    rmSync(temp, { recursive: true, force: true });
  }
});
