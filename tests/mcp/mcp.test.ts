import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type McpModule = typeof import("../../packages/mcp/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let mcp: McpModule;
let tempDir: string;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, mcp] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<McpModule>("/packages/mcp/src/index.ts"),
  ]);
  tempDir = mkdtempSync(join(tmpdir(), "harness-mcp-"));
});

afterAll(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await harness.close();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const SERVER_SOURCE = (marker: string) => `
const readline = require("node:readline");
const fs = require("node:fs");
const marker = ${JSON.stringify(marker)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let tools = [
  {
    name: "echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
];
let listed = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    listed += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    if (listed === 1) {
      tools = tools.concat([
        { name: "second", description: "Second tool", inputSchema: { type: "object" } },
      ]);
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    return;
  }
  if (message.method === "tools/call") {
    const args = message.params && message.params.arguments ? message.params.arguments : {};
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: args.text === "reject"
        ? { isError: true, content: [{ type: "text", text: "fixture rejected input" }] }
        : { content: [{ type: "text", text: "echo:" + String(args.text || "") }] },
    });
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
const markExit = () => {
  try { fs.writeFileSync(marker, "terminated"); } catch {}
};
process.on("SIGTERM", () => {
  markExit();
  process.exit(0);
});
process.on("exit", markExit);
`;

function writeServer(name: string): { script: string; marker: string } {
  const marker = join(tempDir, `${name}.terminated`);
  const script = join(tempDir, `${name}.cjs`);
  writeFileSync(script, SERVER_SOURCE(marker));
  return { script, marker };
}

function createService() {
  const scope = di.createRootScope();
  scope.provideAll([mcp.McpService]);
  const service = scope.get(mcp.McpService);
  return {
    scope,
    service,
    dispose: async () => {
      await service.dispose();
      scope.dispose();
    },
  };
}

const REFRESH_SERVER_SOURCE = String.raw`
const readline = require("node:readline");
const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
const result = (id, value) => send({ id, result: value });
const catalog = (id, version) => result(id, { tools: [{
  name: "echo",
  description: version,
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    properties: { version: { const: version } },
    required: ["version"],
  },
}] });
let lists = 0;
let heldList;
let holdObserver;
let nextList;
let version = "current";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "refresh-fixture", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    lists++;
    if (lists === 1 || nextList === "hold") {
      heldList = message.id;
      if (lists === 1) {
        send({ method: "notifications/tools/list_changed" });
        send({ method: "notifications/tools/list_changed" });
      }
      if (holdObserver !== undefined) result(holdObserver, { content: [] });
    } else if (nextList === "fail") {
      send({ id: message.id, error: { code: -32603, message: "fixture refresh failed" } });
      version = "recovered";
    } else {
      catalog(message.id, version);
    }
    nextList = undefined;
  } else if (message.method === "tools/call") {
    if (message.params.name === "when_refresh_held") {
      if (heldList === undefined) holdObserver = message.id;
      else result(message.id, { content: [] });
    } else if (message.params.name === "release_refresh") {
      catalog(heldList, "older");
      heldList = undefined;
      holdObserver = undefined;
      result(message.id, { content: [], structuredContent: { listRequests: lists } });
    } else if (message.params.name === "next_refresh") {
      nextList = message.params.arguments.action;
      result(message.id, { content: [] });
    } else {
      result(message.id, {
        content: [],
        structuredContent: { version, listRequests: lists },
      });
    }
  }
});
`;

describe("mcp stdio servers", () => {
  it(
    "refreshes the published catalog and SDK validators serially on the same connection",
    {
      timeout: 20_000,
    },
    async () => {
      const opened = createService();
      const id = "refresh-order";
      const releaseInitialList = async () => {
        await waitFor(() => opened.service.getStatus(id) === "connected", "connected");
        await opened.service.callTool(id, "when_refresh_held");
        const released = await opened.service.callTool(id, "release_refresh");
        expect(released).toMatchObject({ structuredContent: { listRequests: 1 } });
        await waitFor(
          () => opened.service.tools.value[0]?.description === "current",
          "updated list",
        );
        await expect(opened.service.callTool(id, "echo")).resolves.toMatchObject({
          structuredContent: { version: "current", listRequests: 2 },
        });
      };
      try {
        opened.service.registerServer({
          id,
          label: "Refresh order fixture",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", REFRESH_SERVER_SOURCE],
          startupTimeoutMs: 5_000,
          toolTimeoutMs: 5_000,
        });
        await releaseInitialList();
        await opened.service.callTool(id, "next_refresh", { action: "fail" });
        const failure = expect(opened.service.refreshTools(id)).rejects.toThrow(
          "fixture refresh failed",
        );
        const recovery = opened.service.refreshTools(id);
        await failure;
        expect(opened.service.tools.value.map((tool) => tool.description)).toEqual(["current"]);
        await expect(recovery).resolves.toMatchObject([{ description: "recovered" }]);
        await expect(opened.service.callTool(id, "echo")).resolves.toMatchObject({
          structuredContent: { version: "recovered", listRequests: 4 },
        });

        await opened.service.callTool(id, "next_refresh", { action: "hold" });
        const retired = opened.service.refreshTools(id);
        void retired.catch(() => {});
        await opened.service.callTool(id, "when_refresh_held");
        const queued = opened.service.refreshTools(id);
        const closed = Promise.allSettled([retired, queued]);
        const disconnected = opened.service.disconnect(id);
        await Promise.all([opened.service.connect(id), releaseInitialList(), disconnected]);
        expect(await closed).toEqual([
          expect.objectContaining({ status: "rejected" }),
          { status: "fulfilled", value: [] },
        ]);
      } finally {
        await opened.dispose();
      }
    },
  );

  it(
    "lists qualified tools, calls a tool and refreshes after list_changed",
    { timeout: 20_000 },
    async () => {
      const { script, marker } = writeServer("fixture");
      const opened = createService();
      try {
        const unregister = opened.service.registerServer({
          id: "fixture",
          label: "Fixture",
          transport: "stdio",
          command: process.execPath,
          args: [script],
          startupTimeoutMs: 10_000,
          toolTimeoutMs: 10_000,
        });
        await waitFor(
          () => opened.service.getStatus("fixture") === "connected",
          "server connection",
        );
        await waitFor(() => opened.service.tools.value.length === 2, "refreshed tool list");

        const tools = await opened.service.listTools("fixture");
        expect(tools.map((tool) => tool.rawName).sort()).toEqual(["echo", "second"]);
        expect(tools.find((tool) => tool.rawName === "echo")).toMatchObject({
          serverId: "fixture",
          qualifiedName: "mcp__fixture__echo",
          description: "Echo text back",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        });

        const result = (await opened.service.callTool("fixture", "echo", { text: "hello" })) as {
          content: Array<{ type: string; text: string }>;
        };
        expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);

        const definition = opened.service.toolDefinitions.value.find(
          (tool) => tool.declaration().name === "mcp__fixture__echo",
        );
        expect(definition).toBeDefined();
        const definitionResult = (await definition!.invoke(
          llm.ToolCallBlock.create({
            id: "definition",
            name: "mcp__fixture__echo",
            arguments: JSON.stringify({ text: "through-definition" }),
          }),
          { callId: "definition", signal: AbortSignal.any([]) },
        )) as string;
        expect(JSON.parse(definitionResult)).toEqual({
          content: [{ type: "text", text: "echo:through-definition" }],
        });

        const failure = await opened.service.callTool("fixture", "echo", { text: "reject" });
        expect(failure).toEqual({
          isError: true,
          content: [{ type: "text", text: "fixture rejected input" }],
        });
        const [context, linkedTree, llm, sqlite, toolCall] = await Promise.all([
          harness.load<typeof import("../../packages/context/src/index.ts")>(
            "/packages/context/src/index.ts",
          ),
          harness.load<typeof import("../../packages/linked-tree/src/index.ts")>(
            "/packages/linked-tree/src/index.ts",
          ),
          harness.load<typeof import("../../packages/llm/src/index.ts")>(
            "/packages/llm/src/index.ts",
          ),
          harness.load<typeof import("../../packages/sqlite/src/index.ts")>(
            "/packages/sqlite/src/index.ts",
          ),
          harness.load<typeof import("../../packages/tool-call/src/index.ts")>(
            "/packages/tool-call/src/index.ts",
          ),
        ]);
        opened.scope.provideAll([
          di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
          linkedTree.LinkedTree,
          context.Context,
          toolCall.ToolCallService,
        ]);
        const toolsService = opened.scope.get(toolCall.ToolCallService);
        opened.scope.run(() => toolsService.useTool(definition!));
        const [resultMessage] = await toolsService.execute([
          llm.ToolCallBlock.create({
            id: "reject",
            name: "mcp__fixture__echo",
            arguments: JSON.stringify({ text: "reject" }),
          }),
        ]);
        expect(resultMessage?.isError).toBe(true);
        expect(JSON.parse(llm.extractText(resultMessage!.content))).toEqual(failure);

        await opened.dispose();
        await waitFor(() => existsSync(marker), "server process termination");
        unregister();
      } finally {
        await opened.dispose();
      }
    },
  );

  it("marks a server failed when its process exits during startup", async () => {
    const opened = createService();
    try {
      opened.service.registerServer({
        id: "broken",
        label: "Broken",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
        startupTimeoutMs: 10_000,
      });
      await waitFor(() => opened.service.getStatus("broken") === "failed", "failed status");
      await expect(opened.service.connect("broken")).rejects.toBeDefined();
      expect(opened.service.tools.value).toEqual([]);
    } finally {
      await opened.dispose();
    }
  });

  it(
    "unregistering a server disconnects it and removes its tools",
    { timeout: 20_000 },
    async () => {
      const { script, marker } = writeServer("unregister");
      const opened = createService();
      try {
        const unregister = opened.service.registerServer({
          id: "temp",
          label: "Temp",
          transport: "stdio",
          command: process.execPath,
          args: [script],
          startupTimeoutMs: 10_000,
        });
        await waitFor(() => opened.service.getStatus("temp") === "connected", "server connection");
        await waitFor(() => opened.service.tools.value.length > 0, "tool discovery");
        unregister();
        await waitFor(() => opened.service.getStatus("temp") === "disconnected", "disconnect");
        expect(opened.service.tools.value).toEqual([]);
        await waitFor(() => existsSync(marker), "server process termination");
      } finally {
        await opened.dispose();
      }
    },
  );
});
