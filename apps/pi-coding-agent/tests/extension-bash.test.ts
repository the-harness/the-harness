import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "uses Pi extension Bash operations for user and model commands",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-bash-"));
    const build = join(temp, "dist");
    const extension = join(temp, "shell.ts");
    const requests: { messages: unknown }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const callTool = requests.length === 1;
      const block = callTool
        ? { type: "tool_use", id: "call_bash", name: "bash", input: {} }
        : { type: "text", text: "" };
      const delta = callTool
        ? { type: "input_json_delta", partial_json: JSON.stringify({ command: "MODEL-COMMAND" }) }
        : { type: "text_delta", text: "Done" };
      const events = [
        [
          "message_start",
          {
            message: {
              id: "msg_bash",
              type: "message",
              role: "assistant",
              model: "deepseek-flash",
              content: [],
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          },
        ],
        ["content_block_start", { index: 0, content_block: block }],
        ["content_block_delta", { index: 0, delta }],
        ["content_block_stop", { index: 0 }],
        [
          "message_delta",
          {
            delta: { stop_reason: callTool ? "tool_use" : "end_turn" },
            usage: { output_tokens: 1 },
          },
        ],
        ["message_stop", {}],
      ] as const;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events
          .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
          .join(""),
      );
    });

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
      import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
      export default function(pi) {
        const operations = {
          async exec(command, cwd, { onData }) {
            onData(Buffer.from("Extension handled " + command));
            return { exitCode: 7 };
          },
        };
        pi.on("user_bash", () => ({ operations }));
        pi.registerTool(createBashToolDefinition(process.cwd(), { operations }));
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
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
      client = new RpcClient({
        cliPath: join(build, "cli.js"),
        cwd: temp,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: "local-only",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          PI_CODING_AGENT_DIR: join(temp, "agent"),
        },
        model: "deepseek-flash",
        args: ["--no-session", "-e", extension],
      });
      const emitted: JsonAgentSessionEvent[] = [];
      client.onEvent((event) => emitted.push(event));
      await client.start();
      expect(await client.bash("USER-COMMAND")).toMatchObject({
        output: "Extension handled USER-COMMAND",
        exitCode: 7,
      });
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: "bash_execution_update",
          delta: "Extension handled USER-COMMAND",
        }),
      );
      const [, disposition] = await Promise.all([
        client.waitForIdle(15_000),
        client.prompt("Run a Bash command."),
      ]);
      expect(disposition).toBe("started");
      expect(requests).toHaveLength(2);
      const wire = JSON.stringify(requests[1]?.messages);
      expect(wire).toContain("Extension handled MODEL-COMMAND");
      expect(wire).toContain('"is_error":true');
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: "tool_execution_end",
          toolName: "bash",
          isError: true,
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({ exit_code: 7 }),
          }),
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
