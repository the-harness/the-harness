import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import type { MockStep } from "../../packages/mock-llm/src/index.ts";
import { createCompactionHarness } from "./helpers.ts";

it("preserves the durable Codex checkpoint until a complete nonempty summary is available", async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "codex-incomplete-summary-"));
  const path = join(directory, "history.db");
  const harness = await createCompactionHarness();
  const { codex, user } = harness;
  try {
    const writer = harness.open({}, path, "durable summary");
    try {
      writer.context.pending.push(user("earlier conversation"));
      writer.context.batch();
      await writer.compaction.compact();
      writer.context.pending.push(user("unsummarized conversation"));
      writer.context.batch();
    } finally {
      await writer.close();
    }

    const incomplete = [
      { text: "provider failed", stopReason: "error", error: { message: "provider failed" } },
      { text: "partial canceled summary", stopReason: "aborted" },
      { text: "partial truncated summary", stopReason: "max_tokens" },
      { text: "unfinished tool request", stopReason: "tool_calls" },
      { text: " \n ", stopReason: "stop" },
    ] satisfies MockStep[];
    for (const step of incomplete) {
      const failing = harness.open({}, path, step);
      try {
        await expect(failing.compaction.compact()).rejects.toThrow();
        expect(failing.model.requests).toHaveLength(1);
        expect(await failing.compaction.latestSlice()).toMatchObject({ to: 0 });
        failing.model.verify();
      } finally {
        await failing.close();
      }
    }

    const resumed = harness.open({}, path, "complete replacement", "continued");
    try {
      const saved = await resumed.compaction.latestSlice();
      expect(saved).toMatchObject({ to: 0 });
      expect(saved?.messages.at(-1)).toBeInstanceOf(codex.CodexCompactionSummaryMessage);
      expect(saved?.messages.at(-1)).toMatchObject({ summary: "durable summary" });
      await resumed.compaction.compact();
      const request = resumed.model.requests[0]!.request;
      expect(request.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ summary: "durable summary" }),
          expect.objectContaining({ content: [{ text: "unsummarized conversation" }] }),
        ]),
      );
      resumed.context.pending.push(user("continue"));
      expect(await resumed.loop.run()).toBe("completed");
      expect(resumed.model.requests[1]!.request.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ summary: "complete replacement" }),
          expect.objectContaining({ content: [{ text: "continue" }] }),
        ]),
      );
      resumed.model.verify();
    } finally {
      await resumed.close();
    }

    const reader = harness.open({}, path);
    try {
      const saved = await reader.compaction.latestSlice();
      expect(saved?.messages.at(-1)).toBeInstanceOf(codex.CodexCompactionSummaryMessage);
      expect(saved?.messages.at(-1)).toMatchObject({ summary: "complete replacement" });
    } finally {
      await reader.close();
    }
  } finally {
    await harness.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
