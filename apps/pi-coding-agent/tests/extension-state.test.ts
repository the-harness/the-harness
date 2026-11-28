import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "restores extension entries and custom messages after an extension-only session is closed",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-extension-state-"));
    const build = join(temp, "dist");
    const extension = join(temp, "extension.ts");
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(Buffer.concat(chunks).toString());
      const events = [
        [
          "message_start",
          {
            message: {
              id: "msg_extension",
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
    function createClient(args: string[] = []) {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
      return new RpcClient({
        cliPath: join(build, "cli.js"),
        cwd: temp,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: "local-only",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          PI_CODING_AGENT_DIR: join(temp, "agent"),
        },
        model: "deepseek-flash",
        args: ["--session-dir", join(temp, "sessions"), "-e", extension, ...args],
      });
    }
    let client: RpcClient | undefined;
    try {
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      writeFileSync(
        extension,
        `
      export default function(pi) {
        pi.registerCommand("stamp", {
          description: "Record extension state",
          handler() {
            pi.appendEntry("extension-state", { count: 1, $variants: ["opaque-data"] });
            pi.sendMessage({ customType: "note", content: "Extension context", display: false, details: { count: 1 } });
          },
        });
        pi.registerCommand("trigger", {
          description: "Start a custom turn",
          async handler(args, ctx) {
            pi.sendMessage({ customType: "trigger", content: "Custom trigger", display: false }, { triggerTurn: true });
            await ctx.waitForIdle();
          },
        });
        pi.on("before_agent_start", (event) => {
          if (event.messageType === "custom") {
            return { message: { customType: "hook", content: "Custom trigger hook", display: false } };
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
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      client = createClient();
      await client.start();
      const { sessionId } = await client.getState();
      expect(await client.prompt("/stamp")).toBe("handled");
      expect(requests).toHaveLength(0);
      const { entries } = await client.getEntries();
      const state = entries.find((entry) => entry.type === "custom");
      expect(state).toMatchObject({
        customType: "extension-state",
        data: { count: 1, $variants: ["opaque-data"] },
      });
      await client.stop();

      client = createClient(["--session", sessionId]);
      await client.start();
      expect((await client.getEntries()).entries).toContainEqual(state);
      expect(await client.getMessages()).toContainEqual(
        expect.objectContaining({
          role: "custom",
          customType: "note",
          content: "Extension context",
          display: false,
          details: { count: 1 },
        }),
      );
      expect(await client.clone()).toEqual({ cancelled: false });
      expect((await client.getEntries()).entries).toContainEqual(
        expect.objectContaining({
          type: "custom",
          customType: "extension-state",
          data: { count: 1, $variants: ["opaque-data"] },
        }),
      );
      const [, disposition] = await Promise.all([
        client.waitForIdle(15_000),
        client.prompt("/trigger"),
      ]);
      expect(disposition).toBe("handled");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("Custom trigger hook");
      expect(await client.getMessages()).toContainEqual(
        expect.objectContaining({
          role: "custom",
          customType: "trigger",
          content: "Custom trigger",
        }),
      );
    } finally {
      await client?.stop();
      server.closeAllConnections();
      server.close();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

it(
  "passes extension CLI flags to startup, reload, and replacement sessions",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-extension-flags-"));
    const build = join(temp, "dist");
    const extension = join(temp, "flags.ts");
    const cliPath = join(build, "cli.js");
    const env = { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent") };
    const args = ["--offline", "--approve", "--no-session", "-e", extension];
    function cli(...options: string[]) {
      return spawnSync(process.execPath, [cliPath, ...args, ...options], {
        cwd: temp,
        env,
        encoding: "utf8",
        input: "",
        timeout: 15_000,
      });
    }
    try {
      writeFileSync(
        extension,
        `
      export default function(pi) {
        pi.registerFlag("probe", { type: "boolean", default: false, description: "Enable the flag fixture" });
        pi.registerFlag("label", { type: "string", default: "default", description: "Label the flag fixture" });
        pi.on("session_start", ({ reason }) => {
          pi.appendEntry("flags", { reason, probe: pi.getFlag("probe"), label: pi.getFlag("label") });
        });
        pi.registerCommand("reload-flags", {
          description: "Reload the extension runtime",
          async handler(_args, ctx) { await ctx.reload(); },
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
      const help = cli("--probe", "--help");
      expect(help.status).toBe(0);
      expect(help.stdout).toMatch(/--label <value> +Label the flag fixture/);
      const missing = cli("--label");
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('Extension flag "--label" requires a value');
      const unknown = cli("--label=known", "--bad-flag");
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain("Unknown option: --bad-flag");

      const client = new RpcClient({
        cliPath,
        cwd: temp,
        env,
        args: [...args, "--label=first", "--probe", "--label", "review"],
      });
      try {
        await client.start();
        async function expectFlags(reason: string) {
          expect((await client.getEntries()).entries).toContainEqual(
            expect.objectContaining({
              type: "custom",
              customType: "flags",
              data: { reason, probe: true, label: "review" },
            }),
          );
        }
        await expectFlags("startup");
        expect(await client.prompt("/reload-flags")).toBe("handled");
        await expectFlags("reload");
        expect(await client.newSession()).toEqual({ cancelled: false });
        await expectFlags("new");
      } finally {
        await client.stop();
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
