import { expect, it } from "vite-plus/test";
import { createCompactionHarness } from "./helpers.ts";

it("bounds a retained user message to Codex's default 20k text budget before continuing the agent", async () => {
  const harness = await createCompactionHarness();
  const { llm, user } = harness;
  const session = harness.open({}, ":memory:", "bounded summary", "continued");
  const text = "a".repeat(50_000) + "z".repeat(50_000);
  try {
    const original = user(text);
    session.context.pending.push(original);
    session.context.batch();
    await session.compaction.compact();
    session.context.pending.push(user("continue"));
    expect(await session.loop.run()).toBe("completed");
    expect(session.model.requests).toHaveLength(2);
    expect(session.model.requests[0]!.request.messages[0]).toMatchObject({
      content: [{ text }],
    });
    const retained = session.model.requests[1]!.request.messages[0];
    expect(retained).toBeInstanceOf(llm.UserMessage);
    expect(retained).toMatchObject({
      id: original.id,
      content: [{ text: "a".repeat(40_000) + "…5000 tokens truncated…" + "z".repeat(40_000) }],
    });
    expect(original.content).toMatchObject([{ text }]);
    session.model.verify();
  } finally {
    await session.close();
    await harness.close();
  }
});

it("spends the remaining user budget on UTF-8 text without splitting Chinese characters or emoji", async () => {
  const harness = await createCompactionHarness();
  const { llm, user } = harness;
  const session = harness.open({ keepRecentUserTokens: 3 }, ":memory:", "summary", "continued");
  try {
    session.context.pending.push(
      user("too old"),
      llm.UserMessage.create({
        content: [llm.TextBlock.create({ text: "甲😀" }), llm.TextBlock.create({ text: "乙" })],
      }),
      user("new!"),
    );
    session.context.batch();
    await session.compaction.compact();
    const slice = await session.compaction.latestSlice();
    expect(slice?.messages).toMatchObject([
      { content: [{ text: "甲…1 tokens truncated…乙" }] },
      { content: [{ text: "new!" }] },
      { summary: "summary" },
    ]);
    session.context.pending.push(user("continue"));
    expect(await session.loop.run()).toBe("completed");
    expect(session.model.requests[1]!.request.messages[0]).toMatchObject({
      content: [{ text: "甲…1 tokens truncated…乙" }],
    });
    session.model.verify();
  } finally {
    await session.close();
    await harness.close();
  }
});

it("does not charge discarded images against the retained user text budget", async () => {
  const harness = await createCompactionHarness();
  const { llm, user } = harness;
  const session = harness.open({ keepRecentUserTokens: 2 }, ":memory:", "summary", "continued");
  try {
    session.context.pending.push(
      user("old!"),
      llm.UserMessage.create({
        content: [
          llm.TextBlock.create({ text: "new!" }),
          llm.ImageBlock.create({ mimeType: "image/png", data: "image-data" }),
        ],
      }),
    );
    session.context.batch();
    await session.compaction.compact();
    session.context.pending.push(user("continue"));
    expect(await session.loop.run()).toBe("completed");
    expect(session.model.requests[1]!.request.messages).toMatchObject([
      { content: [{ text: "old!" }] },
      { content: [{ text: "new!" }] },
      { summary: "summary" },
      { content: [{ text: "continue" }] },
    ]);
    session.model.verify();
  } finally {
    await session.close();
    await harness.close();
  }
});
