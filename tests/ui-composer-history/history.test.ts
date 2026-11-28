import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type HistoryModule = typeof import("../../packages/ui-composer-history/src/history.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");

let harness: HarnessModules;
let history: HistoryModule;
let llm: LlmModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [history, llm] = await Promise.all([
    harness.load<HistoryModule>("/packages/ui-composer-history/src/history.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function user(text: string) {
  return llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] });
}

function source(options: {
  messages?: Array<{ role: string; text: string }>;
  pending?: string[];
  queued?: string[];
}): Parameters<HistoryModule["ComposerPromptHistory"]["navigateOlder"]>[2] {
  return {
    messages: options.messages ?? [],
    pending: (options.pending ?? []).map(user),
    queued: (options.queued ?? []).map(user),
  } as never;
}

describe("composer prompt history", () => {
  it("collects previous prompts from history, pending and queue with adjacent dedupe", () => {
    const prompts = source({
      messages: [
        { role: "user", text: "first" },
        { role: "assistant", text: "reply" },
        { role: "user", text: "first" },
        { role: "user", text: "second" },
      ],
      pending: ["third"],
      queued: ["third", "fourth"],
    });
    const historyState = new history.ComposerPromptHistory();
    expect(historyState.navigateOlder("", 0, prompts)).toEqual({ text: "fourth", caret: 0 });
    expect(historyState.navigateOlder("fourth", 0, prompts)).toEqual({ text: "third", caret: 0 });
    expect(historyState.navigateOlder("third", 0, prompts)).toEqual({ text: "second", caret: 0 });
  });

  it("moves back to the saved draft and restores the caret at the end", () => {
    const prompts = source({ messages: [{ role: "user", text: "older" }] });
    const historyState = new history.ComposerPromptHistory();
    expect(historyState.navigateOlder("draft", 5, prompts)).toEqual({ text: "draft", caret: 0 });

    const state = new history.ComposerPromptHistory();
    expect(state.navigateOlder("draft", 0, prompts)).toEqual({ text: "older", caret: 0 });
    expect(state.navigateNewer("older", 5)).toEqual({ text: "draft", caret: 0 });
    expect(state.navigateNewer("draft", 5)).toBeNull();
  });

  it("limits history to the latest 100 prompts", () => {
    const messages = Array.from({ length: 105 }, (_, index) => ({
      role: "user",
      text: `prompt-${index}`,
    }));
    const state = new history.ComposerPromptHistory();
    const first = state.navigateOlder("", 0, source({ messages }));
    expect(first).toEqual({ text: "prompt-104", caret: 0 });
    let current = first!;
    for (let index = 0; index < 99; index++) {
      current = state.navigateOlder(current.text, 0, source({ messages }))!;
    }
    expect(current).toEqual({ text: "prompt-5", caret: 0 });
    expect(state.navigateOlder(current.text, 0, source({ messages }))).toEqual({
      text: "prompt-5",
      caret: 0,
    });
  });

  it("ignores navigation inside a multiline draft and resets after editing", () => {
    const prompts = source({
      messages: [
        { role: "user", text: "first" },
        { role: "user", text: "second" },
      ],
    });
    const state = new history.ComposerPromptHistory();
    expect(state.navigateOlder("line one\nline two", 10, prompts)).toBeNull();
    expect(state.navigateOlder("line one\nline two", 0, prompts)).toEqual({
      text: "second",
      caret: 0,
    });

    state.observe("second edited");
    expect(state.navigateOlder("second edited", 0, prompts)).toEqual({
      text: "second",
      caret: 0,
    });

    expect(state.navigateOlder("second", 3, prompts)).toEqual({ text: "first", caret: 0 });
  });

  it("does nothing without source prompts or when navigating newer without history", () => {
    const state = new history.ComposerPromptHistory();
    expect(state.navigateOlder("", 0, source({}))).toBeNull();
    expect(state.navigateNewer("draft", 0)).toBeNull();
  });
});
