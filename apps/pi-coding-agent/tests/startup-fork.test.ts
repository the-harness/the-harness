import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION, RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "returns a duplicate-session error when two CLI processes fork to the same ID",
  {
    timeout: 60_000,
  },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-fork-"));
    const build = join(temp, "dist");
    const sessions = join(temp, "sessions");
    const source = join(temp, "source.jsonl");
    const clients: RpcClient[] = [];
    try {
      mkdirSync(sessions);
      const database = join(sessions, "harness.sqlite");
      const legacy = new DatabaseSync(database);
      try {
        legacy.exec(
          "CREATE TABLE pi_cli_sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        );
        legacy
          .prepare("INSERT INTO pi_cli_sessions VALUES (?, ?, ?)")
          .run("legacy", temp, Date.now());
      } finally {
        legacy.close();
      }
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      writeFileSync(
        source,
        [
          {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: "source",
            timestamp: new Date().toISOString(),
            cwd: temp,
          },
          {
            type: "message",
            id: "entry",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "Forked history", timestamp: Date.now() },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      execFileSync("pnpm", [
        "--filter",
        "@harness/pi-coding-agent-cli",
        "build",
        "--outDir",
        build,
      ]);
      const env = { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent") };
      const options = {
        cliPath: join(build, "cli.js"),
        cwd: temp,
        env,
        args: [
          "--offline",
          "--no-approve",
          "-ne",
          "--session-dir",
          sessions,
          "--fork",
          source,
          "--session-id",
          "fork-target",
        ],
      };
      clients.push(new RpcClient(options), new RpcClient(options));
      const outcomes = await Promise.allSettled(
        clients.map(async (client) => {
          await client.start();
          return (await client.getState()).sessionId;
        }),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toEqual([
        { status: "fulfilled", value: "fork-target" },
      ]);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      expect(String(failure?.reason)).toContain("Session already exists with id 'fork-target'");
      const migrated = new DatabaseSync(database, { readOnly: true });
      try {
        expect(
          migrated.prepare("SELECT model_id FROM pi_cli_sessions WHERE id = ?").get("legacy"),
        ).toMatchObject({ model_id: null });
      } finally {
        migrated.close();
      }
    } finally {
      await Promise.allSettled(clients.map((client) => client.stop()));
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

it(
  "isolates compaction from the source session and preserves it in subsequent forks",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-fork-compaction-"));
    const build = join(temp, "dist");
    const agent = join(temp, "agent");
    const extension = join(temp, "compaction.ts");
    const wire = join(temp, "requests.jsonl");
    const original = "ORIGINAL-DETAIL-819";
    const summary = "FORK-SUMMARY-973";
    try {
      mkdirSync(agent);
      writeFileSync(
        join(agent, "settings.json"),
        JSON.stringify({
          compaction: { enabled: false, keepRecentTokens: 1 },
        }),
      );
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      writeFileSync(
        extension,
        `
      import { appendFileSync } from "node:fs";
      import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
      export default function (pi) {
        pi.on("session_before_compact", ({ preparation, customInstructions }) => ({
          compaction: {
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            summary: customInstructions,
          },
        }));
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        pi.registerProvider("fork-fixture", {
          baseUrl: "http://127.0.0.1:1", apiKey: "local", api: "fork-fixture",
          models: [{ id: "local", name: "Local", input: ["text"], reasoning: false, cost,
            contextWindow: 100_000, maxTokens: 1_000 }],
          streamSimple(model, context) {
            appendFileSync(${JSON.stringify(wire)}, JSON.stringify(context.messages) + "\\n");
            const stream = createAssistantMessageEventStream();
            const reply = {
              role: "assistant", provider: model.provider, api: model.api, model: model.id,
              timestamp: Date.now(), stopReason: "stop",
              usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { ...cost, total: 0 } },
              content: [{ type: "text", text: "Acknowledged." }],
            };
            stream.push({ type: "done", reason: "stop", message: reply });
            stream.end();
            return stream;
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
          env: { ...process.env, PI_CODING_AGENT_DIR: agent },
          args: [
            "--offline",
            "--approve",
            "--no-context-files",
            "-e",
            extension,
            "--session-dir",
            join(temp, "sessions"),
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
      async function turn(rpc: RpcClient, prompt: string) {
        const [, disposition] = await Promise.all([rpc.waitForIdle(15_000), rpc.prompt(prompt)]);
        expect(disposition).toBe("started");
        return readFileSync(wire, "utf8").trimEnd().split("\n").at(-1);
      }

      let sourceEntryId: string | undefined;
      await session(["--session-id", "source", "--model", "fork-fixture/local"], async (rpc) => {
        await turn(rpc, original);
        sourceEntryId = (await rpc.getForkMessages()).find(
          ({ text }) => text === original,
        )?.entryId;
        expect(sourceEntryId).toBeDefined();
        await turn(rpc, "Middle detail");
        await turn(rpc, "Recent detail");
      });
      await session(["--fork", "source", "--session-id", "child"], async (rpc) => {
        expect((await rpc.compact(summary)).summary).toBe(summary);
        expect((await rpc.clone()).cancelled).toBe(false);
        const request = await turn(rpc, "Cloned the compacted head.");
        expect(request).toContain(summary);
        expect(request).not.toContain(original);
      });
      await session(["--session", "child"], async (rpc) => {
        const recent = (await rpc.getForkMessages()).find(({ text }) => text === "Recent detail");
        if (!recent) throw new Error("Expected a recent message to fork from");
        expect((await rpc.fork(recent.entryId)).cancelled).toBe(false);
        expect((await rpc.getEntries()).entries.some((entry) => entry.type === "compaction")).toBe(
          false,
        );
        const request = await turn(rpc, "Forked before the summary was written.");
        expect(request).toContain(original);
        expect(request).not.toContain(summary);
        expect(request).not.toContain("Recent detail");
      });
      await session(["--session", "source"], async (rpc) => {
        expect((await rpc.getEntries()).entries.some((entry) => entry.type === "compaction")).toBe(
          false,
        );
        expect((await rpc.getForkMessages()).find(({ text }) => text === original)?.entryId).toBe(
          sourceEntryId,
        );
        const request = await turn(rpc, "Continued the source.");
        expect(request).toContain(original);
        expect(request).not.toContain(summary);
      });
      for (const options of [
        ["--session", "child"],
        ["--fork", "child", "--session-id", "grandchild"],
      ]) {
        await session(options, async (rpc) => {
          expect((await rpc.getEntries()).entries).toContainEqual(
            expect.objectContaining({ type: "compaction", summary }),
          );
          const request = await turn(rpc, "Continued the compacted branch.");
          expect(request).toContain(summary);
          expect(request).not.toContain(original);
        });
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
