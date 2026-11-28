import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type MarkdownModule = typeof import("../../packages/ui-chat/src/workbench/markdown.ts");

let harness: HarnessModules;
let markdown: MarkdownModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  markdown = await harness.load<MarkdownModule>("/packages/ui-chat/src/workbench/markdown.ts");
});

afterAll(async () => {
  await harness.close();
});

describe("MarkdownHighlighterService", () => {
  it("shares one load between calls and becomes ready", async () => {
    const service = new markdown.MarkdownHighlighterService();
    expect(service.ready.value).toBe(false);

    const first = service.load();
    const second = service.load();
    expect(second).toBe(first);
    await first;

    expect(service.ready.value).toBe(true);
    expect(service.highlighter).toBeDefined();
    expect(service.load()).toBe(first);
  }, 30_000);

  it("keeps the highlighter per service instance", async () => {
    const loaded = new markdown.MarkdownHighlighterService();
    await loaded.load();
    const fresh = new markdown.MarkdownHighlighterService();

    expect(fresh.ready.value).toBe(false);
    expect(fresh.highlighter).toBeUndefined();
    const freshLoad = fresh.load();
    expect(freshLoad).not.toBe(loaded.load());
    await freshLoad;
    expect(fresh.highlighter).not.toBe(loaded.highlighter);
  }, 30_000);
});
