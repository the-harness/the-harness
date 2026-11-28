import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type ContextModule = typeof import("../../packages/context/src/index.ts");
type LinkedTreeModule = typeof import("../../packages/linked-tree/src/index.ts");
type ModelSelectionModule = typeof import("../../packages/model-selection/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");
type CwdModule = typeof import("../../packages/cwd/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type ToolCallModule = typeof import("../../packages/tool-call/src/index.ts");
type ToolsModule = typeof import("../../packages/pi-tools/src/index.ts");

let harness: HarnessModules;
let contextModule: ContextModule;
let cwdModule: CwdModule;
let di: DiModule;
let llm: LlmModule;
let toolCallModule: ToolCallModule;
let tools: ToolsModule;
let linkedTree: LinkedTreeModule;
let modelSelection: ModelSelectionModule;
let sqlite: SqliteModule;
let workspace: string;

beforeAll(async () => {
  harness = await createHarnessModules();
  [contextModule, cwdModule, di, llm, toolCallModule, tools, linkedTree, modelSelection, sqlite] =
    await Promise.all([
      harness.load<ContextModule>("/packages/context/src/index.ts"),
      harness.load<CwdModule>("/packages/cwd/src/index.ts"),
      harness.load<DiModule>("/packages/di/src/index.ts"),
      harness.load<LlmModule>("/packages/llm/src/index.ts"),
      harness.load<ToolCallModule>("/packages/tool-call/src/index.ts"),
      harness.load<ToolsModule>("/packages/pi-tools/src/index.ts"),
      harness.load<LinkedTreeModule>("/packages/linked-tree/src/index.ts"),
      harness.load<ModelSelectionModule>("/packages/model-selection/src/index.ts"),
      harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
    ]);
  workspace = mkdtempSync(join(process.cwd(), "tests/.tmp-tools-"));
});

afterAll(async () => {
  rmSync(workspace, { recursive: true, force: true });
  await harness.close();
});

interface ToolRun {
  readonly text: string;
  readonly isError: boolean;
}

function createScope() {
  const scope = di.createRootScope();
  scope.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    linkedTree.LinkedTree,
    di.createDescriptor(contextModule.Context, { id: "tools" }),
    di.createDescriptor(cwdModule.CwdService, workspace),
    di.createDescriptor(modelSelection.ModelSelectionService, { provider: "mock", model: "mock" }),
    toolCallModule.ToolCallService,
  ]);
  scope.run(() => tools.usePiTools());
  return scope;
}

let callId = 0;

async function runTool(
  service: InstanceType<ToolCallModule["ToolCallService"]>,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolRun> {
  const [result] = await service.execute(
    [
      llm.ToolCallBlock.create({
        id: `call-${++callId}`,
        name,
        arguments: JSON.stringify(args),
      }),
    ],
    signal,
  );
  return {
    text: llm.extractText(result!.content),
    isError: result!.isError === true,
  };
}

describe("coding tools", () => {
  it("writes files with missing parent directories and reads them back", async () => {
    const scope = createScope();
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      const written = await runTool(service, "write", {
        path: "nested/deep/notes.txt",
        content: "first\nsecond\n",
      });
      expect(written).toEqual({
        text: "Successfully wrote to nested/deep/notes.txt",
        isError: false,
      });
      expect(readFileSync(join(workspace, "nested/deep/notes.txt"), "utf-8")).toBe(
        "first\nsecond\n",
      );

      const read = await runTool(service, "read", { path: "nested/deep/notes.txt" });
      expect(read).toEqual({ text: "first\nsecond\n", isError: false });

      await runTool(service, "write", { path: "nested/deep/notes.txt", content: "replaced" });
      expect(readFileSync(join(workspace, "nested/deep/notes.txt"), "utf-8")).toBe("replaced");
    } finally {
      scope.dispose();
    }
  });

  it("honours read offset and limit and reports offsets beyond the end", async () => {
    const scope = createScope();
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      await runTool(service, "write", {
        path: "lines.txt",
        content: "one\ntwo\nthree\nfour",
      });

      expect(await runTool(service, "read", { path: "lines.txt", offset: 2 })).toEqual({
        text: "two\nthree\nfour",
        isError: false,
      });
      expect(await runTool(service, "read", { path: "lines.txt", offset: 2, limit: 2 })).toEqual({
        text: "two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]",
        isError: false,
      });
      const beyond = await runTool(service, "read", { path: "lines.txt", offset: 9 });
      expect(beyond.isError).toBe(true);
      expect(beyond.text).toBe("Offset 9 is beyond end of file (4 lines total)");
    } finally {
      scope.dispose();
    }
  });

  it("truncates large reads and points at a bash fallback for oversized lines", async () => {
    const scope = createScope();
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      const lines = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
      await runTool(service, "write", { path: "large.txt", content: lines });

      const truncated = await runTool(service, "read", { path: "large.txt" });
      expect(truncated.text).toContain(
        "[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]",
      );

      const longLine = "x".repeat(51 * 1024);
      await runTool(service, "write", { path: "wide.txt", content: longLine });
      const fallback = await runTool(service, "read", { path: "wide.txt" });
      expect(fallback.text).toBe(
        `[Line 1 is 51.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' wide.txt | head -c 51200]`,
      );
    } finally {
      scope.dispose();
    }
  });

  it("applies multiple disjoint edits against the original file", async () => {
    const scope = createScope();
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      await runTool(service, "write", {
        path: "edit.txt",
        content: "alpha\nbeta\ngamma\ndelta\n",
      });

      const edited = await runTool(service, "edit", {
        path: "edit.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA\nextra" },
        ],
      });

      expect(edited).toEqual({
        text: "Successfully replaced 2 block(s) in edit.txt.",
        isError: false,
      });
      expect(readFileSync(join(workspace, "edit.txt"), "utf-8")).toBe(
        "ALPHA\nbeta\nGAMMA\nextra\ndelta\n",
      );
    } finally {
      scope.dispose();
    }
  });

  it("preserves a BOM and CRLF line endings while matching normalized text", async () => {
    const scope = createScope();
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      writeFileSync(join(workspace, "windows.txt"), "\uFEFFone\r\ntwo\r\nthree\r\n", "utf-8");

      const edited = await runTool(service, "edit", {
        path: "windows.txt",
        edits: [{ oldText: "one\ntwo", newText: "one\nTWO" }],
      });

      expect(edited.isError).toBe(false);
      expect(readFileSync(join(workspace, "windows.txt"), "utf-8")).toBe(
        "\uFEFFone\r\nTWO\r\nthree\r\n",
      );
    } finally {
      scope.dispose();
    }
  });

  it("rejects missing, ambiguous, overlapping and no-op edits", async () => {
    const scope = createScope();
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      await runTool(service, "write", {
        path: "invalid.txt",
        content: "same same\nkeep\n",
      });

      const missing = await runTool(service, "edit", {
        path: "invalid.txt",
        edits: [{ oldText: "absent", newText: "x" }],
      });
      expect(missing.isError).toBe(true);
      expect(missing.text).toBe("Could not find edits[0] in invalid.txt.");

      const ambiguous = await runTool(service, "edit", {
        path: "invalid.txt",
        edits: [{ oldText: "same", newText: "x" }],
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.text).toBe("Found 2 occurrences of edits[0] in invalid.txt.");

      const overlapping = await runTool(service, "edit", {
        path: "invalid.txt",
        edits: [
          { oldText: "same same", newText: "x" },
          { oldText: "same\nkeep", newText: "y" },
        ],
      });
      expect(overlapping.isError).toBe(true);
      expect(overlapping.text).toBe("edits[0] and edits[1] overlap in invalid.txt.");

      const noChange = await runTool(service, "edit", {
        path: "invalid.txt",
        edits: [{ oldText: "keep", newText: "keep" }],
      });
      expect(noChange.isError).toBe(true);
      expect(noChange.text).toBe("No changes made to invalid.txt.");
    } finally {
      scope.dispose();
    }
  });

  it("runs bash commands in the workspace and reports exit codes", async () => {
    const scope = createScope();
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      const success = await runTool(service, "bash", { command: "printf hello" });
      expect(success).toEqual({ text: "hello", isError: false });

      const empty = await runTool(service, "bash", { command: "true" });
      expect(empty).toEqual({ text: "(no output)", isError: false });

      const failed = await runTool(service, "bash", {
        command: "printf problem >&2; exit 3",
      });
      expect(failed.isError).toBe(true);
      expect(failed.text).toBe("problem\n\nCommand exited with code 3");

      const large = await runTool(service, "bash", { command: "seq 1 3000" });
      expect(large.isError).toBe(false);
      expect(large.text.startsWith("1001\n1002\n")).toBe(true);
      expect(large.text).toMatch(/\[Showing lines 1001-3000 of 3000\. Full output: .+\]/);
    } finally {
      scope.dispose();
    }
  });

  it("times out and aborts bash commands with partial output", async () => {
    const scope = createScope();
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      const timedOut = await runTool(service, "bash", {
        command: "printf started; sleep 5",
        timeout: 0.2,
      });
      expect(timedOut.isError).toBe(true);
      expect(timedOut.text).toBe("started\n\nCommand timed out after 0.2 seconds");

      const controller = new AbortController();
      const aborted = runTool(
        service,
        "bash",
        { command: "printf started; sleep 5" },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 200);
      const result = await aborted;
      expect(result.isError).toBe(true);
      expect(result.text).toBe("started\n\nCommand aborted");
    } finally {
      scope.dispose();
    }
  });
});
