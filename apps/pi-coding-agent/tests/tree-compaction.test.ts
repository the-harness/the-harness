import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";

it(
  "restores uncompressed context when navigating to an entry before compaction",
  { timeout: 60_000 },
  () => verifyPreCompactionBranch("manual"),
);

it.each(["threshold", "overflow"] as const)(
  "restores uncompressed context when navigating to an entry before %s compaction",
  { timeout: 60_000 },
  verifyPreCompactionBranch,
);

async function verifyPreCompactionBranch(reason: "manual" | "threshold" | "overflow") {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(artifacts, "pi-cli-tree-compaction-"));
  const build = join(temp, "dist");
  const agent = join(temp, "agent");
  const extension = join(temp, "tree.ts");
  const requests: { system: unknown; messages: unknown; tools?: { name: string }[] }[] = [];
  const summaryRequests: typeof requests = [];
  const cachedInput = reason === "manual" ? 100_000 : 0;
  const contextTokens = cachedInput + 25;
  let overflowed = false;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const summarizing = JSON.stringify(body.system).includes("context summarization assistant");
    if (summarizing) summaryRequests.push(body);
    if (summarizing && summaryRequests.length === 1) {
      response.writeHead(529, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "overloaded_error" },
        }),
      );
      return;
    }
    if (
      reason === "overflow" &&
      !overflowed &&
      !summarizing &&
      JSON.stringify(body.messages).includes("After compaction")
    ) {
      overflowed = true;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "maximum context length exceeded" },
        }),
      );
      return;
    }
    const text = summarizing
      ? "COMPACTION-MARKER"
      : JSON.stringify(body.system).includes("Summarize the branch being left")
        ? "BRANCH-SUMMARY-MARKER"
        : `Reply ${requests.length}`;
    const events = [
      [
        "message_start",
        {
          message: {
            id: "msg_tree",
            type: "message",
            role: "assistant",
            model: "deepseek-flash",
            content: [],
            usage: {
              input_tokens: 20,
              output_tokens: 0,
              cache_read_input_tokens: summarizing ? 0 : cachedInput,
            },
          },
        },
      ],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
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
    mkdirSync(agent);
    writeFileSync(
      join(agent, "settings.json"),
      JSON.stringify({
        compaction: {
          enabled: reason === "manual",
          keepRecentTokens: 20,
          reserveTokens:
            reason === "overflow" ? 0 : 1_048_576 - (reason === "manual" ? 150_000 : 0),
        },
        retry: { enabled: true, baseDelayMs: 1, maxRetries: 1 },
      }),
    );
    writeFileSync(
      extension,
      `
      export default function(pi) {
        pi.on("before_agent_start", ({ prompt }) => {
          if (prompt?.startsWith("ORIGINAL-MARKER")) pi.setActiveTools(["read"]);
          if (prompt?.startsWith("Latest question")) pi.setActiveTools(["write"]);
        });
        pi.registerCommand("goto", {
          description: "Select a Pi session entry",
          handler: (args, ctx) => ctx.navigateTree(args),
        });
        pi.registerCommand("goto-summary", {
          description: "Select a Pi session entry with a summary",
          handler: (args, ctx) => ctx.navigateTree(args, { summarize: true }),
        });
        pi.registerCommand("usage", {
          description: "Record context usage",
          handler: (_args, ctx) => pi.appendEntry("context-usage", ctx.getContextUsage()),
        });
      }
    `,
    );
    symlinkSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(temp, "node_modules"),
      "junction",
    );
    execFileSync("pnpm", ["--filter", "@harness/pi-coding-agent-cli", "build", "--outDir", build]);
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
    const rpc = new RpcClient({
      cliPath: join(build, "cli.js"),
      cwd: temp,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "local-only",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        PI_CODING_AGENT_DIR: agent,
      },
      model: "deepseek-flash",
      args: ["--session-dir", join(temp, "sessions"), "-e", extension],
    });
    client = rpc;
    await rpc.start();

    async function turn(text: string) {
      const [, disposition] = await Promise.all([rpc.waitForIdle(15_000), rpc.prompt(text)]);
      expect(disposition).toBe("started");
      return JSON.stringify(requests.at(-1)?.messages);
    }

    await turn("ORIGINAL-MARKER " + "old material ".repeat(200));
    await turn("Earlier question " + "more details ".repeat(100));
    const { entries } = await rpc.getEntries();
    const earlier = entries.findLast(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    if (!earlier) throw new Error("Expected an assistant entry before compaction");
    await turn("Latest question " + "retained text ".repeat(20));
    const lifecycle: unknown[] = [];
    const unsubscribe = rpc.onEvent((event) => {
      if (event.type === "compaction_start") lifecycle.push([event.type, event.reason]);
      if (event.type === "summarization_retry_scheduled") {
        lifecycle.push([event.type, event.attempt, event.maxAttempts, event.delayMs]);
      }
      if (event.type === "summarization_retry_attempt_start") {
        lifecycle.push([event.type, event.source, event.source === "compaction" && event.reason]);
      }
      if (event.type === "summarization_retry_finished") lifecycle.push([event.type]);
      if (event.type === "compaction_end") {
        lifecycle.push([
          event.type,
          event.reason,
          event.aborted,
          event.willRetry,
          event.result?.summary,
        ]);
      }
    });
    let compacted: string;
    try {
      if (reason === "manual") {
        expect(summaryRequests).toHaveLength(0);
        expect((await rpc.getSessionStats()).contextUsage?.tokens).toBe(contextTokens);
        expect(await rpc.compact()).toMatchObject({
          summary: "COMPACTION-MARKER",
          tokensBefore: contextTokens,
        });
        expect(await rpc.prompt("/usage")).toBe("handled");
        const usage = (await rpc.getSessionStats()).contextUsage;
        expect(usage).toMatchObject({ tokens: null, percent: null });
        expect((await rpc.getEntries()).entries).toContainEqual(
          expect.objectContaining({
            type: "custom",
            customType: "context-usage",
            data: usage,
          }),
        );
      } else await rpc.setAutoCompaction(true);
      compacted = await turn("After compaction");
    } finally {
      unsubscribe();
    }
    expect(lifecycle).toEqual([
      ["compaction_start", reason],
      ["summarization_retry_scheduled", 1, 1, 1],
      ["summarization_retry_attempt_start", "compaction", reason],
      ["summarization_retry_finished"],
      ["compaction_end", reason, false, reason === "overflow", "COMPACTION-MARKER"],
    ]);
    expect(summaryRequests).toHaveLength(2);
    expect(summaryRequests[0]).toEqual(summaryRequests[1]);
    if (reason === "overflow") {
      const summarized = JSON.stringify(summaryRequests[0]?.messages);
      expect(summarized).toContain("Latest question");
      expect(summarized).not.toContain("After compaction");
    }
    expect(
      (await rpc.getEntries()).entries.some(
        (entry) => entry.type === "compaction" && entry.summary === "COMPACTION-MARKER",
      ),
    ).toBe(true);
    expect(compacted).toContain("COMPACTION-MARKER");
    expect(compacted).not.toContain("ORIGINAL-MARKER");
    expect(requests.at(-1)?.tools?.map(({ name }) => name)).toEqual(["write"]);
    expect((await rpc.getSessionStats()).contextUsage?.tokens).toBe(contextTokens);

    await rpc.setAutoCompaction(false);
    expect(
      await rpc.prompt(`/${reason === "manual" ? "goto-summary" : "goto"} ${earlier.id}`),
    ).toBe("handled");
    const selected = await turn("From the earlier branch");
    expect(selected).toContain("ORIGINAL-MARKER");
    expect(selected).not.toContain("COMPACTION-MARKER");
    expect(selected).not.toContain("Latest question");
    expect(requests.at(-1)?.tools?.map(({ name }) => name)).toEqual(["read"]);
    if (reason === "manual") {
      expect(selected).toContain(
        "The user explored a different conversation branch before returning here.",
      );
      expect(selected).toContain("BRANCH-SUMMARY-MARKER");
    }
  } finally {
    await client?.stop();
    provider.closeAllConnections();
    provider.close();
    rmSync(temp, { recursive: true, force: true });
  }
}
