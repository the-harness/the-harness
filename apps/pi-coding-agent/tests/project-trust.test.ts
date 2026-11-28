import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT_SESSION_VERSION,
  ProjectTrustStore,
  RpcClient,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "gates extension startup and model-visible skills on the project trust decision",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-trust-"));
    const build = join(temp, "dist");
    const agent = join(temp, "agent");
    const cwd = join(temp, "project");
    const proof = join(temp, "project-extension-loaded");
    const requests: { system: unknown }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const events = [
        [
          "message_start",
          {
            message: {
              id: "msg_trust",
              type: "message",
              role: "assistant",
              model: "deepseek-flash",
              content: [],
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          },
        ],
        ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Done" } }],
        ["content_block_stop", { index: 0 }],
        ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", {}],
      ] as const;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events
          .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
          .join(""),
      );
    });

    try {
      const extensions = join(cwd, ".pi", "extensions");
      const skills = join(cwd, ".pi", "skills", "trust-fixture");
      mkdirSync(agent);
      mkdirSync(extensions, { recursive: true });
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "ask" }));
      writeFileSync(
        join(skills, "SKILL.md"),
        "---\nname: trust-fixture\ndescription: PROJECT-SKILL-MARKER\n---\nProject skill\n",
      );
      writeFileSync(
        join(extensions, "probe.ts"),
        `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(proof)}, "loaded");
      export default function() {}
    `,
      );
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
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
      const env = {
        ...process.env,
        DEEPSEEK_API_KEY: "local-only",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        PI_CODING_AGENT_DIR: agent,
      };
      for (const trusted of [false, true]) {
        const client = new RpcClient({
          cliPath: join(build, "cli.js"),
          cwd,
          env,
          model: "deepseek-flash",
          args: trusted ? ["--no-session", "--approve"] : ["--no-session"],
        });
        try {
          await client.start();
          expect(existsSync(proof)).toBe(trusted);
          const [, disposition] = await Promise.all([
            client.waitForIdle(15_000),
            client.prompt("Reply briefly."),
          ]);
          expect(disposition).toBe("started");
          expect(JSON.stringify(requests.at(-1)?.system)?.includes("PROJECT-SKILL-MARKER")).toBe(
            trusted,
          );
          expect(new ProjectTrustStore(agent).get(cwd)).toBeNull();
        } finally {
          await client.stop();
        }
      }

      const explicit = join(temp, "explicit-loaded");
      const unexpected = join(temp, "unexpected-loaded");
      for (const [directory, marker] of [
        [temp, explicit],
        [cwd, unexpected],
      ] as const) {
        writeFileSync(
          join(directory, "explicit.ts"),
          `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(marker)}, "loaded");
        export default function() {}
      `,
        );
      }
      const jsonl = join(temp, "session.jsonl");
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "imported",
        cwd,
        timestamp: new Date().toISOString(),
      };
      writeFileSync(jsonl, JSON.stringify(header) + "\n");
      const crossCwd = new RpcClient({
        cliPath: join(build, "cli.js"),
        cwd: temp,
        env,
        model: "deepseek-flash",
        args: [
          "--session",
          jsonl,
          "--session-dir",
          join(temp, "sessions"),
          "--no-approve",
          "-e",
          "./explicit.ts",
        ],
      });
      try {
        await crossCwd.start();
        expect(existsSync(explicit)).toBe(true);
        expect(existsSync(unexpected)).toBe(false);
      } finally {
        await crossCwd.stop();
      }
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

it(
  "replays updated and deleted project instructions after CLI resume and compaction",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-resume-instructions-"));
    const build = join(temp, "dist");
    const agent = join(temp, "agent");
    const extension = join(temp, "hook.ts");
    const hook = join(temp, "hook-prompt");
    const instructions = join(temp, "AGENTS.md");
    const requests: {
      readonly system?: string;
      readonly messages: readonly { role: string; content: readonly { text?: string }[] }[];
      readonly tools?: readonly { name: string }[];
    }[] = [];
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const events = [
        [
          "message_start",
          {
            message: {
              id: "msg_resume",
              type: "message",
              role: "assistant",
              model: "deepseek-flash",
              content: [],
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          },
        ],
        ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Result" } }],
        ["content_block_stop", { index: 0 }],
        ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", {}],
      ] as const;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events
          .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
          .join(""),
      );
    });

    try {
      mkdirSync(agent);
      writeFileSync(
        join(agent, "settings.json"),
        JSON.stringify({
          compaction: { enabled: false, keepRecentTokens: 1 },
        }),
      );
      writeFileSync(
        extension,
        `
      import { writeFileSync } from "node:fs";
      export default function(pi) {
        pi.on("before_agent_start", (event) => {
          writeFileSync(${JSON.stringify(hook)}, event.systemPrompt);
          if (event.prompt === "select read only") pi.setActiveTools(["read"]);
          if (event.prompt === "use an override") return { systemPrompt: "EPHEMERAL-PROMPT" };
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
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");

      async function withSession(args: string[], run: (client: RpcClient) => Promise<void>) {
        const client = new RpcClient({
          cliPath: join(build, "cli.js"),
          cwd: temp,
          env: {
            ...process.env,
            DEEPSEEK_API_KEY: "local-only",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
            PI_CODING_AGENT_DIR: agent,
          },
          model: "deepseek-flash",
          args: [
            "--offline",
            "--approve",
            "--no-tools",
            "--tools",
            "read,bash",
            "--session-dir",
            join(temp, "sessions"),
            "-e",
            extension,
            ...args,
          ],
        });
        try {
          await client.start();
          await run(client);
        } finally {
          await client.stop();
        }
      }

      async function prompt(client: RpcClient, text: string) {
        const [, disposition] = await Promise.all([
          client.waitForIdle(15_000),
          client.prompt(text),
        ]);
        expect(disposition).toBe("started");
        const request = requests.at(-1)!;
        const latestIndex = request.messages.findLastIndex(({ role }) => role === "system");
        const latest = request.messages[latestIndex];
        return {
          tools: request.tools?.map(({ name }) => name),
          triggeringInput: latest ? request.messages[latestIndex - 1] : undefined,
          leading: request.system,
          effective: latest
            ? latest.content.map(({ text }) => text ?? "").join("")
            : request.system,
          hookPrompt: readFileSync(hook, "utf8"),
        };
      }

      writeFileSync(instructions, "Project marker is FIRST-PROJECT-MARKER.");
      let firstPrompt: string | undefined;
      await withSession(["--session-id", "replay-instructions"], async (client) => {
        const result = await prompt(client, "first turn");
        firstPrompt = result.effective;
        expect(result.hookPrompt).toBe(firstPrompt);
        expect(firstPrompt).toContain("FIRST-PROJECT-MARKER");
      });

      writeFileSync(instructions, "Project marker is SECOND-PROJECT-MARKER.");
      await withSession(["--continue"], async (client) => {
        const result = await prompt(client, "resumed turn");
        expect(result.leading).toBe(firstPrompt);
        expect(result.hookPrompt).toBe(result.effective);
        expect(result.effective).toContain("SECOND-PROJECT-MARKER");
        expect(result.effective).not.toContain("FIRST-PROJECT-MARKER");
        expect(result.triggeringInput).toMatchObject({
          role: "user",
          content: [expect.objectContaining({ text: "resumed turn" })],
        });
        const { entries } = await client.getEntries();
        const updateIndex = entries.findLastIndex(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "system" &&
            entry.message.sections?.project_context?.includes("SECOND-PROJECT-MARKER"),
        );
        expect(updateIndex).toBeGreaterThan(-1);
        expect(entries[updateIndex + 1]).toMatchObject({
          type: "message",
          message: { role: "user", content: [expect.objectContaining({ text: "resumed turn" })] },
        });

        const changedTools = await prompt(client, "select read only");
        expect(changedTools.tools).toEqual(["read"]);
        expect(changedTools.effective).not.toContain("- bash:");
        const afterToolChange = await prompt(client, "next turn");
        expect(afterToolChange.effective).toBe(changedTools.effective);
        expect(afterToolChange.hookPrompt).toBe(changedTools.effective);

        const forced = await prompt(client, "use an override");
        expect(forced.effective).toBe("EPHEMERAL-PROMPT");
        expect(forced.hookPrompt).toBe(changedTools.effective);
        expect((await prompt(client, "historical context ".repeat(100))).effective).toBe(
          changedTools.effective,
        );
        await client.compact();
      });

      unlinkSync(instructions);
      await withSession(["--continue"], async (client) => {
        const result = await prompt(client, "turn after compaction and file deletion");
        expect(result.hookPrompt).toBe(result.effective);
        expect(result.effective).not.toContain("FIRST-PROJECT-MARKER");
        expect(result.effective).not.toContain("SECOND-PROJECT-MARKER");
        expect(
          (await client.getEntries()).entries.some((entry) => entry.type === "compaction"),
        ).toBe(true);
      });
      await withSession(["--continue", "--no-context-files"], async (client) => {
        expect(
          (await prompt(client, "turn without inherited instructions")).effective,
        ).not.toContain("<project_context>");
        expect((await client.getEntries()).entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "system",
                sections: expect.objectContaining({ project_context: null }),
              }),
            }),
          ]),
        );
      });
    } finally {
      provider.closeAllConnections();
      provider.close();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
