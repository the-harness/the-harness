import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { effectScope, type EffectScope } from "reactivity";
import { AgentLoop, SupplementaryField } from "../../packages/agent-loop/src/index.ts";
import { AgentsMdService } from "../../packages/agents-md/src/index.ts";
import { Context } from "../../packages/context/src/index.ts";
import { ContextSizeService } from "../../packages/context-size/src/index.ts";
import { CwdService } from "../../packages/cwd/src/index.ts";
import { createDescriptor, createRootScope } from "../../packages/di/src/index.ts";
import {
  extractText,
  LlmProvider,
  LlmService,
  MessageMeta,
  SystemMessage,
  TextModality,
  type LlmModelInfo,
  TextBlock,
  ToolResultMessage,
  UserMessage,
} from "../../packages/llm/src/index.ts";
import { LinkedTree } from "../../packages/linked-tree/src/index.ts";
import { McpService } from "../../packages/mcp/src/index.ts";
import { ScriptedMockLlmProvider } from "../../packages/mock-llm/src/index.ts";
import { ProviderManager } from "../../packages/model-provider/src/index.ts";
import { ModelSelectionService } from "../../packages/model-selection/src/index.ts";
import { PiCodingAgentPreset } from "../../packages/pi-coding-agent/src/index.ts";
import { PiCompactionService } from "../../packages/pi-compaction/src/index.ts";
import {
  useBashTool,
  useEditTool,
  useFindTool,
  useGrepTool,
  useLsTool,
  useReadTool,
  useWriteTool,
} from "../../packages/pi-tools/src/index.ts";
import { SkillsService } from "../../packages/skills/src/index.ts";
import { SqliteService } from "../../packages/sqlite/src/index.ts";
import { ToolCallService } from "../../packages/tool-call/src/index.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-pi-align-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function createHarness(cwd: string, systemPromptUpdate?: LlmModelInfo["systemPromptUpdate"]) {
  const mockProvider = createDescriptor(ScriptedMockLlmProvider, {
    provider: "mock",
    models: [
      {
        id: "mock-model",
        name: "Mock",
        provider: "mock",
        reasoning: true,
        inputModalities: [TextModality.create()],
        outputModalities: [TextModality.create()],
        contextWindow: 100000,
        maxTokens: 4096,
        systemPromptUpdate,
      },
    ],
  });

  const root = createRootScope();
  root.provideAll([
    ProviderManager,
    LlmService,
    McpService,
    LinkedTree,
    createDescriptor(SqliteService, { path: ":memory:" }),
  ]);
  const providerScope = root.get(ProviderManager).create({ id: "mock" });
  providerScope.provide(mockProvider);
  const mock = providerScope.get(LlmProvider) as ScriptedMockLlmProvider;

  const agentScope = root.createChild();
  agentScope.provideAll([
    Context,
    ContextSizeService,
    PiCompactionService,
    ToolCallService,
    AgentsMdService,
    SkillsService,
    createDescriptor(CwdService, cwd),
    createDescriptor(ModelSelectionService, {
      provider: "mock",
      model: "mock-model",
      reasoning: "high",
    }),
    AgentLoop,
  ]);
  const setups: Record<string, () => void> = {
    read: useReadTool,
    bash: useBashTool,
    edit: useEditTool,
    write: useWriteTool,
    grep: useGrepTool,
    find: useFindTool,
    ls: useLsTool,
  };
  let toolEffects: EffectScope | undefined;
  function setTools(names: string[]): void {
    toolEffects?.stop();
    agentScope.run(() => {
      toolEffects = effectScope();
      toolEffects.run(() => {
        for (const name of names) setups[name]!();
      });
    });
  }
  agentScope.setup(() => {
    PiCodingAgentPreset.create({ id: "pi-coding-agent", name: "Pi Coding Agent" }).setup(
      undefined,
      {
        registerTools: false,
      },
    );
  });
  setTools(["read", "bash", "edit", "write"]);

  return {
    root,
    mock,
    setTools,
    context: agentScope.get(Context),
    loop: agentScope.get(AgentLoop),
  };
}

describe("pi-coding-agent model-visible surface alignment", () => {
  it("matches pi XML system prompt structure, AGENTS.md, skills, and tool order", async () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, "AGENTS.md"), "Always prefer strict TypeScript.", "utf-8");
    const skillDir = join(cwd, ".pi", "skills", "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill description\n---\n\n# Demo\n",
      "utf-8",
    );

    const { root, mock, context, loop } = createHarness(cwd);
    try {
      mock.enqueue({ text: "ok" });
      context.pending.push(UserMessage.create({ content: [TextBlock.create({ text: "hi" })] }));
      expect(await loop.run()).toBe("completed");

      const req = mock.requests[0]!.request;
      const sys = req.systemPrompt ?? "";
      expect(
        sys.startsWith(
          "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
        ),
      ).toBe(true);
      expect(sys).toContain("<tools>\n");
      expect(sys).toContain("Additional tools may be available.\n</tools>");
      expect(sys).toContain("<rules>\n- Use bash for file operations like ls, rg, find");
      expect(sys).toContain(
        "You can inspect PI_* environment variables for current model and session details.",
      );
      expect(sys).toContain("<project_context>\nProject-specific instructions and guidelines:");
      expect(sys).toContain("Always prefer strict TypeScript.");
      expect(sys).toContain("<skills>");
      expect(sys).toContain("<name>demo-skill</name>");
      expect(sys).toContain(`<cwd>\n${cwd.replaceAll("\\", "/")}\n</cwd>`);

      expect(req.tools?.map((t) => t.name)).toEqual(["read", "bash", "edit", "write"]);
    } finally {
      root.dispose();
    }
  });

  it("matches pi tool outputs for write, read, edit (including legacy args), bash PI_* env, and unknown tools", async () => {
    const cwd = makeTempDir();
    const { root, mock, context, loop } = createHarness(cwd);
    try {
      mock.enqueue(
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "a.txt", content: "hello\nworld\n" } },
            { id: "c2", name: "nonexistent", arguments: {} },
          ],
        },
        {
          toolCalls: [
            { id: "c3", name: "read", arguments: { path: "a.txt" } },
            {
              id: "c4",
              name: "edit",
              arguments: { path: "a.txt", oldText: "world", newText: "pi" },
            },
            {
              id: "c5",
              name: "bash",
              arguments: {
                command: 'printf "%s|%s|%s" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"',
              },
            },
          ],
        },
        { text: "done" },
      );

      context.pending.push(UserMessage.create({ content: [TextBlock.create({ text: "run" })] }));
      expect(await loop.run()).toBe("completed");

      const allToolResults = mock.requests
        .at(-1)!
        .request.messages.filter((m): m is ToolResultMessage => m instanceof ToolResultMessage);
      const byId = new Map(allToolResults.map((m) => [m.toolCallId, m]));

      expect(extractText(byId.get("c1")!.content)).toBe("Successfully wrote to a.txt");
      expect(byId.get("c2")!.isError).toBe(true);
      expect(extractText(byId.get("c2")!.content)).toBe("Tool nonexistent not found");
      expect(extractText(byId.get("c3")!.content)).toBe("hello\nworld\n");
      expect(extractText(byId.get("c4")!.content)).toBe(
        "Successfully replaced 1 block(s) in a.txt.",
      );
      expect(extractText(byId.get("c5")!.content)).toBe("mock|mock-model|high");
    } finally {
      root.dispose();
    }
  });

  it("emits incremental system prompt section updates without mutating initial systemPrompt", async () => {
    const cwd = makeTempDir();
    const { root, setTools, mock, context, loop } = createHarness(cwd, "in-history");
    try {
      mock.enqueue({ text: "first" });
      context.pending.push(
        SystemMessage.create({
          content: [
            TextBlock.create({ text: "Keep the workspace instructions in every request." }),
          ],
          meta: new MessageMeta().set(SupplementaryField, true),
        }),
        UserMessage.create({ content: [TextBlock.create({ text: "turn 1" })] }),
      );
      expect(await loop.run()).toBe("completed");

      const firstSystemPrompt = mock.requests[0]!.request.systemPrompt;

      setTools(["read", "bash", "edit", "write", "grep"]);

      mock.enqueue({ text: "second" });
      context.pending.push(UserMessage.create({ content: [TextBlock.create({ text: "turn 2" })] }));
      expect(await loop.run()).toBe("completed");

      const secondReq = mock.requests[1]!.request;
      expect(firstSystemPrompt).toContain("Keep the workspace instructions in every request.");
      expect(firstSystemPrompt).not.toContain("- grep:");
      expect(secondReq.systemPrompt).toBe(firstSystemPrompt);
      const update = secondReq.messages.find((message) => message instanceof SystemMessage);
      expect(extractText(update?.content ?? [])).toContain("- grep: Search file contents");
    } finally {
      root.dispose();
    }
  });
});
