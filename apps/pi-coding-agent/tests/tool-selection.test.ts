import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "sends the Pi default tools in declaration order with matching system instructions",
  { timeout: 60_000 },
  async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-tools-"));
    const build = join(temp, "dist");
    let body: { tools: { name: string }[]; system: unknown } | undefined;
    const server = createServer(async (incoming, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
      const events = [
        [
          "message_start",
          {
            message: {
              id: "msg_tools",
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

    let client: RpcClient | undefined;
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
        args: ["--no-session", "--no-extensions"],
      });
      await client.start();
      const [, disposition] = await Promise.all([
        client.waitForIdle(15_000),
        client.prompt("Reply briefly."),
      ]);
      expect(disposition).toBe("started");
      if (!body) throw new Error("Expected a provider request");
      const order = ["read", "bash", "edit", "write"];
      expect(body.tools.map(({ name }) => name)).toEqual(order);
      const prompt = JSON.stringify(body.system).match(/<tools>(.*?)<\/tools>/)?.[1] ?? "";
      const listed = [...prompt.matchAll(/- (\w+):/g)].map((match) => match[1]);
      expect(listed).toEqual(order);
    } finally {
      await client?.stop();
      server.closeAllConnections();
      server.close();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
