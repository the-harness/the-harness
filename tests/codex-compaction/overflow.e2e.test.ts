import { expect, it } from "vite-plus/test";
import { createCompactionHarness } from "./helpers.ts";

it("recovers the agent loop when compaction itself overflows without leaving orphan tool results", async () => {
  const harness = await createCompactionHarness();
  const { codex, llm, user } = harness;
  const session = harness.open({ baseInstructions: () => "base instructions" });
  const overflow = { stopReason: "error", error: { message: "context_length_exceeded" } } as const;
  session.model.enqueue(overflow, overflow, overflow, "trimmed summary", "continued");
  try {
    session.context.pending.push(user("old user request"));
    session.context.batch();
    session.context.pending.push(
      llm.AssistantMessage.create({
        provider: "mock",
        model: "mock",
        content: [
          llm.ToolCallBlock.create({ id: "first", name: "read", arguments: "{}" }),
          llm.ToolCallBlock.create({ id: "second", name: "read", arguments: "{}" }),
        ],
      }),
    );
    session.context.batch();
    session.context.pending.push(
      ...["first", "second"].map((id) =>
        llm.ToolResultMessage.create({
          toolCallId: id,
          toolName: "read",
          content: [llm.TextBlock.create({ text: "large tool output" })],
        }),
      ),
      user("recent request"),
    );
    session.context.batch();
    session.context.pending.push(user("continue"));

    expect(await session.loop.run()).toBe("completed");
    const requests = session.model.requests.map((record) => record.request);
    expect(requests).toHaveLength(5);
    expect(requests[1]!.messages).toHaveLength(6);
    expect(requests[2]!.messages).toHaveLength(5);
    expect(requests[2]!.messages[0]).toBeInstanceOf(llm.AssistantMessage);
    expect(requests[3]!.messages).toMatchObject([
      { content: [{ text: "recent request" }] },
      { content: [{ text: codex.SUMMARIZATION_PROMPT }] },
    ]);
    for (const request of requests.slice(1, 4)) {
      expect(request.systemPrompt).toBe("base instructions");
      expect(request.messages.at(-1)).toMatchObject({
        content: [{ text: codex.SUMMARIZATION_PROMPT }],
      });
    }
    expect(requests[4]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: "trimmed summary" }),
        expect.objectContaining({ content: [{ text: "continue" }] }),
      ]),
    );
    expect(await session.compaction.latestSlice()).toMatchObject({ to: 2 });
    session.model.verify();
  } finally {
    await session.close();
    await harness.close();
  }
});

it("stops compaction overflow retries at the prompt without changing the stored history", async () => {
  const harness = await createCompactionHarness();
  const session = harness.open();
  try {
    session.context.pending.push(harness.user("original history"));
    session.context.batch();
    session.model.enqueue(
      () => {
        throw new Error("maximum context length exceeded");
      },
      () => {
        throw new Error("maximum context length exceeded");
      },
    );
    await expect(session.compaction.compact()).rejects.toThrow("maximum context length exceeded");
    expect(session.model.requests).toHaveLength(2);
    expect(session.model.requests[1]!.request.messages).toMatchObject([
      { content: [{ text: harness.codex.SUMMARIZATION_PROMPT }] },
    ]);
    expect(await session.compaction.latestSlice()).toBeUndefined();
    session.model.enqueue("retry summary");
    await session.compaction.compact();
    expect(session.model.requests[2]!.request.messages[0]).toMatchObject({
      content: [{ text: "original history" }],
    });
    session.model.verify();
  } finally {
    await session.close();
    await harness.close();
  }
});

it("does not retry a canceled compaction even when the provider reports overflow", async () => {
  const harness = await createCompactionHarness();
  const session = harness.open();
  const controller = new AbortController();
  try {
    session.context.pending.push(harness.user("original history"));
    session.context.batch();
    session.model.enqueue(() => {
      controller.abort();
      throw new Error("context_length_exceeded");
    });
    await expect(
      session.compaction.compact(undefined, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(session.model.requests).toHaveLength(1);
    expect(await session.compaction.latestSlice()).toBeUndefined();
    session.model.verify();
  } finally {
    await session.close();
    await harness.close();
  }
});
