import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type ContextModule = typeof import("../../packages/context/src/index.ts");
type LinkedTreeModule = typeof import("../../packages/linked-tree/src/index.ts");
type ModelSelectionModule = typeof import("../../packages/model-selection/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");
type CwdModule = typeof import("../../packages/cwd/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type ToolCallModule = typeof import("../../packages/tool-call/src/index.ts");
type JobsModule = typeof import("../../packages/jobs/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");
type CodexModule = typeof import("../../packages/codex-tools/src/index.ts");
type CodexApplyPatchModule = typeof import("../../packages/codex-apply-patch/src/index.ts");

let harness: HarnessModules;
let contextModule: ContextModule;
let linkedTree: LinkedTreeModule;
let modelSelection: ModelSelectionModule;
let sqlite: SqliteModule;
let cwdModule: CwdModule;
let di: DiModule;
let toolCallModule: ToolCallModule;
let jobs: JobsModule;
let llm: LlmModule;
let modelProvider: ModelProviderModule;
let codex: CodexModule;
let codexApplyPatch: CodexApplyPatchModule;
let workspace: string;

beforeAll(async () => {
  harness = await createHarnessModules();
  [
    contextModule,
    linkedTree,
    modelSelection,
    sqlite,
    cwdModule,
    di,
    toolCallModule,
    jobs,
    llm,
    modelProvider,
    codex,
    codexApplyPatch,
  ] = await Promise.all([
    harness.load<ContextModule>("/packages/context/src/index.ts"),
    harness.load<LinkedTreeModule>("/packages/linked-tree/src/index.ts"),
    harness.load<ModelSelectionModule>("/packages/model-selection/src/index.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
    harness.load<CwdModule>("/packages/cwd/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<ToolCallModule>("/packages/tool-call/src/index.ts"),
    harness.load<JobsModule>("/packages/jobs/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
    harness.load<CodexModule>("/packages/codex-tools/src/index.ts"),
    harness.load<CodexApplyPatchModule>("/packages/codex-apply-patch/src/index.ts"),
  ]);
  workspace = mkdtempSync(join(tmpdir(), "harness-codex-tools-"));
});

afterAll(async () => {
  rmSync(workspace, { recursive: true, force: true });
  await harness.close();
});

function baseServices() {
  return [
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    linkedTree.LinkedTree,
    di.createDescriptor(contextModule.Context, { id: "codex" }),
    di.createDescriptor(cwdModule.CwdService, workspace),
    di.createDescriptor(modelSelection.ModelSelectionService, { provider: "mock", model: "mock" }),
    toolCallModule.ToolCallService,
    jobs.JobService,
    modelProvider.ProviderManager,
    llm.LlmService,
    codexApplyPatch.CodexApplyPatchService,
  ] as const;
}

async function stopJobs(jobService: InstanceType<JobsModule["JobService"]>): Promise<void> {
  void jobService.root.abort("test cleanup");
  await jobService.root.done.catch(() => {});
}

function createJobScope() {
  const scope = di.createRootScope();
  scope.provideAll([...baseServices()]);
  const jobService = scope.get(jobs.JobService);
  const cwdService = scope.get(cwdModule.CwdService);
  const applyPatch = scope.get(codexApplyPatch.CodexApplyPatchService);
  return {
    scope,
    jobService,
    store: scope.run(() => new codex.ExecSessionStore(jobService, cwdService, applyPatch)),
  };
}

interface ExecResponse {
  readonly chunkId: string;
  readonly status: string;
  readonly originalTokenCount: number;
  readonly output: string;
  readonly sessionId?: number;
}

function parseExec(text: string): ExecResponse {
  const match =
    /^Chunk ID: ([0-9a-f]{6})\nWall time: [\d.]+ seconds\n(Process (?:exited with code -?\d+|running with session ID \d+))\nOriginal token count: (\d+)\nOutput:(?:\n([\s\S]*))?$/.exec(
      text,
    );
  if (!match) throw new Error(`Unexpected exec output: ${text}`);
  const session = /^Process running with session ID (\d+)$/.exec(match[2]!);
  return {
    chunkId: match[1]!,
    status: session ? "running" : match[2]!,
    originalTokenCount: Number(match[3]),
    output: match[4] ?? "",
    ...(session ? { sessionId: Number(session[1]) } : {}),
  };
}

describe("codex exec tools", () => {
  it("registers exec_command and write_stdin in a real scope", async () => {
    const scope = di.createRootScope();
    try {
      scope.provideAll([...baseServices()]);
      expect(() => scope.run(() => codex.useCodexTools())).not.toThrow();
      const service = scope.get(toolCallModule.ToolCallService);
      expect(service.tools.map((tool) => tool.name).sort()).toEqual([
        "exec_command",
        "view_image",
        "web_search",
        "write_stdin",
      ]);
      const [result] = await service.execute([
        llm.ToolCallBlock.create({
          id: "scoped-exec",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "echo scope-owned command" }),
        }),
      ]);
      expect(result?.isError).toBe(false);
      expect(llm.extractText(result!.content)).toContain("scope-owned command");
    } finally {
      scope.dispose();
    }
  });

  it("runs a command in the requested workdir and reports its exit code and output", async () => {
    const opened = createJobScope();
    try {
      const result = await opened.store.execCommand({
        cmd: "pwd; printf 'out\\n'",
        workdir: workspace,
        yield_time_ms: 250,
      });
      const parsed = parseExec(result);
      expect(parsed.status).toBe("Process exited with code 0");
      expect(parsed.chunkId).toMatch(/^[0-9a-f]{6}$/);
      expect(parsed.originalTokenCount).toBeGreaterThan(0);
      expect(parsed.output.trimEnd().split("\n")).toEqual([realpathSync(workspace), "out"]);
    } finally {
      await stopJobs(opened.jobService);
      opened.scope.dispose();
    }
  });

  it("keeps an interactive session and writes stdin until the process exits", async () => {
    const opened = createJobScope();
    try {
      const started = parseExec(
        await opened.store.execCommand({ cmd: "read line; echo got:$line", yield_time_ms: 250 }),
      );
      expect(started.status).toBe("running");
      expect(started.sessionId).toBeGreaterThan(0);

      const finished = parseExec(
        await opened.store.writeStdin({
          session_id: started.sessionId!,
          chars: "hello\n",
          yield_time_ms: 1000,
        }),
      );
      expect(finished.status).toBe("Process exited with code 0");
      expect(finished.output).toContain("got:hello");

      await expect(
        opened.store.writeStdin({ session_id: started.sessionId!, chars: "" }),
      ).rejects.toThrow(`write_stdin failed: Unknown process id ${started.sessionId}`);
    } finally {
      await stopJobs(opened.jobService);
      opened.scope.dispose();
    }
  });

  it("aborts yielded and in-flight commands when their tool setup reruns", async () => {
    const opened = createJobScope();
    const owner = opened.scope.createChild();
    const observeSpawn = vi.spyOn(opened.jobService, "spawn");
    try {
      let store!: InstanceType<CodexModule["ExecSessionStore"]>;
      owner.setup(() => {
        store = new codex.ExecSessionStore(
          opened.jobService,
          di.inject(cwdModule.CwdService),
          di.inject(codexApplyPatch.CodexApplyPatchService),
        );
      });
      const oldStore = store;
      const sibling = parseExec(
        await opened.store.execCommand({ cmd: "read line; echo got:$line", yield_time_ms: 250 }),
      );
      const interactive = parseExec(
        await oldStore.execCommand({ cmd: "read line", yield_time_ms: 250 }),
      );
      expect(sibling.status).toBe("running");
      expect(interactive.status).toBe("running");

      const waiting = oldStore.execCommand({ cmd: "read line", yield_time_ms: 30_000 });
      const rejected = expect(waiting).rejects.toThrow("Exec session scope disposed");
      owner.provide(di.createDescriptor(cwdModule.CwdService, workspace));

      expect(store).not.toBe(oldStore);
      const [siblingJob, ...ownedJobs] = observeSpawn.mock.calls.map(([job]) => job);
      expect(ownedJobs).toHaveLength(2);
      expect(ownedJobs.every((job) => job.abortSignal.aborted)).toBe(true);
      expect(siblingJob?.abortSignal.aborted).toBe(false);
      await rejected;
      await Promise.all(ownedJobs.map((job) => job.done));
      await expect(oldStore.writeStdin({ session_id: interactive.sessionId! })).rejects.toThrow(
        "Exec session scope disposed",
      );
      const replacement = await store.execCommand({ cmd: "echo replacement", yield_time_ms: 250 });
      expect(parseExec(replacement).output).toContain("replacement");

      const output = await opened.store.writeStdin({
        session_id: sibling.sessionId!,
        chars: "alive\n",
        yield_time_ms: 1000,
      });
      expect(parseExec(output).output).toContain("got:alive");
    } finally {
      observeSpawn.mockRestore();
      await stopJobs(opened.jobService);
      opened.scope.dispose();
    }
  });

  it("polls a running session until it exits and returns the buffered output", async () => {
    const opened = createJobScope();
    try {
      const started = parseExec(
        await opened.store.execCommand({ cmd: "sleep 0.6; echo finished", yield_time_ms: 250 }),
      );
      expect(started.status).toBe("running");

      const finished = parseExec(
        await opened.store.writeStdin({
          session_id: started.sessionId!,
          chars: "",
          yield_time_ms: 1000,
        }),
      );
      expect(finished.status).toBe("Process exited with code 0");
      expect(finished.output).toContain("finished");
    } finally {
      await stopJobs(opened.jobService);
      opened.scope.dispose();
    }
  });

  it("aborts a running command and prevents its later side effect", async () => {
    const opened = createJobScope();
    const marker = join(workspace, "aborted-marker.txt");
    rmSync(marker, { force: true });
    try {
      const controller = new AbortController();
      const pending = opened.store.execCommand(
        { cmd: `sleep 0.4; echo late > ${JSON.stringify(marker)}`, yield_time_ms: 30_000 },
        { signal: controller.signal },
      );
      controller.abort(new Error("cancelled by test"));
      await expect(pending).rejects.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(existsSync(marker)).toBe(false);
    } finally {
      await stopJobs(opened.jobService);
      opened.scope.dispose();
    }
  });
});
