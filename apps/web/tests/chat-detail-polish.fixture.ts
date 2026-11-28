import { createDescriptor, createRootScope } from "@harness/di";
import {
  AssistantMessage,
  mergeStreamChunk,
  Message,
  MessageMeta,
  TextBlock,
  ToolResultMessage,
  UserMessage,
  type LlmChunk,
} from "@harness/llm";
import { RpcClientService } from "@harness/rpc";
import {
  StateSyncClientService,
  type StateSyncClient,
  type StateSyncContract,
  type StateSyncEndpoints,
} from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { Transport } from "@harness/transport";
import {
  ActivityRun,
  ChatCoreExtension,
  ChatPanel,
  MarkdownCodeBlock,
  MarkdownHighlighterService,
  ChatDurationField,
  ChatTimestampField,
  ThinkingBlock,
  type ChatRunState,
  type ChatStreamEvent,
} from "@harness/ui-chat";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { BashToolView, LinesToolView, ReadToolView } from "@harness/ui-components-tools";
import { provideScope } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import { SessionsStateSyncContract, UiSessionsService } from "@harness/ui-sessions";
import { UiStorageService } from "@harness/ui-storage";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { createApp, h, ref } from "vue";
import { LocalSessionCatalog } from "./local-session-catalog.ts";
import "virtual:uno.css";
import "../src/style.css";

let menuHistory = false;
const localSessions = new LocalSessionCatalog();

// A stand-in for the backend: committed history plus one run replayed through attachStream.
let history: Message[] = [];
let status: ChatRunState = { runId: null, before: 0, notice: "" };
let run: { readonly events: ChatStreamEvent[]; draft?: AssistantMessage } | undefined;
let results: Message[] = [];
const changed = new Set<() => void>();
const notify = () => {
  for (const wake of [...changed]) wake();
};

function setStatus(next: ChatRunState): void {
  status = next;
  notify();
}

function startRun(events: ChatStreamEvent[] = []): void {
  run = { events: [] };
  for (const event of events) emit(event);
  setStatus({ runId: crypto.randomUUID(), before: 0, notice: "" });
}

function emit(event: ChatStreamEvent): void {
  if (!run) return;
  if (event.type === "chunk") run.draft = mergeStreamChunk(run.draft, event.chunk);
  run.events.push(event);
  notify();
}

// Tool results were already replayed while the run was active.
function finishRun(final: AssistantMessage, stored: readonly Message[]): void {
  emit({ type: "message", message: Message.serialize(final) });
  history = [...history, final, ...stored];
  run = undefined;
  setStatus({ runId: null, before: 0, notice: "" });
}

async function* changes(signal?: AbortSignal): AsyncIterable<void> {
  while (!signal?.aborted) {
    await new Promise<void>((resolve) => {
      const wake = () => {
        changed.delete(wake);
        resolve();
      };
      changed.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
    yield;
  }
}

class LocalTransport extends Transport {
  override async request(path: string, body?: unknown): Promise<unknown> {
    if (localSessions.request(path, body)) return;
    switch (path) {
      case "/rpc/workspace.browseRoot":
        return { root: "/workspace" };
      case "/rpc/chat.listModels":
      case "/rpc/chat.listPresets":
        return [];
      case "/rpc/chat.loadMessages":
        return {
          messages: (menuHistory ? menuMessages() : history).map((message) =>
            Message.serialize(message),
          ),
          nextBefore: null,
          hasMore: false,
        };
      case "/rpc/chat.acknowledgeStatus":
        return;
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  }

  override async *openStream(
    path: string,
    _body?: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<unknown> {
    if (path === "/stream/state-sync:chat.status") {
      yield { type: "snapshot", snapshot: { value: status } };
      for await (const _ of changes(signal)) {
        yield { type: "frame", frame: { type: "value", value: status } };
      }
      return;
    }
    if (path === "/stream/chat.attachStream") {
      const current = run;
      let cursor = 0;
      while (current && !signal?.aborted) {
        while (cursor < current.events.length) yield current.events[cursor++];
        if (run !== current) return;
        for await (const _ of changes(signal)) break;
      }
      return;
    }
    yield { type: "snapshot", snapshot: { rev: 0, items: [] } };
  }

  override childScope() {
    return createDescriptor(LocalTransport);
  }
}

function menuMessages(): Message[] {
  return [
    UserMessage.create({
      id: "prompt",
      content: [TextBlock.create({ text: "Inspect the menu target." })],
    }),
    AssistantMessage.create({
      id: "reply",
      provider: "fixture",
      model: "fixture",
      content: [
        TextBlock.create({
          text: "```ts\nconst target = 'reply';\n```\n\n[Reference](https://example.com/reference)",
        }),
      ],
    }),
  ];
}

class LocalSessions extends StateSyncClientService {
  override use<T extends StateSyncEndpoints>(contract: StateSyncContract<T>): StateSyncClient<T> {
    if (contract.namespace === SessionsStateSyncContract.namespace) {
      return { items: localSessions } as unknown as StateSyncClient<T>;
    }
    return super.use(contract);
  }
}

const scope = createRootScope();
scope.provideAll([
  [Transport, LocalTransport],
  RpcClientService,
  StreamClientService,
  [StateSyncClientService, LocalSessions],
  UiStorageService,
  UiSessionsService,
  UiWorkspaceService,
  UiTabsService,
  UiWorkbenchService,
  UiNotificationService,
  UiChatManagerService,
  MarkdownHighlighterService,
]);

const running = ref(true);
const openedFiles = ref(0);
const longDetail = "packages/very-long-workspace-directory/components/nested-source-directory/ChatPanel.vue";

export function finishActivity(): void {
  running.value = false;
}

export function mountTools(): void {
  createApp({
    setup() {
      provideScope(scope);
      return () => h("div", { style: "width:320px;padding:16px" }, [
        h("output", { "aria-label": "Opened files" }, String(openedFiles.value)),
        h(ReadToolView, {
          path: "src/example.ts",
          content: "export const ready = true;",
          onOpenFile: () => openedFiles.value++,
        }),
        h(LinesToolView, { label: "Grep", detail: longDetail, content: "Found one match" }),
        h(BashToolView, {
          command: `cat ${longDetail}`,
          output: "Command complete",
          codeBlock: MarkdownCodeBlock,
        }),
        h(ActivityRun, {
          streaming: running.value,
          duration: "3s",
          items: [{ id: "tool", kind: "tool", tool: { id: "tool", name: "read" } }],
        }, {
          default: () => h(ReadToolView, { path: "src/active.ts", content: "Active output" }),
        }),
        h(ThinkingBlock, { text: "Checking the result", streaming: running.value, duration: "3s" }),
      ]);
    },
  }).mount("#app");
}

export function mountChat(): void {
  scope.get(UiSessionsService).newSession();
  createApp({
    setup() {
      provideScope(scope);
      return () => [h(ChatCoreExtension), h(ChatPanel)];
    },
  }).mount("#app");
}

const fixtureModel = { provider: "fixture", model: "fixture" };
const chunk = (value: Exclude<LlmChunk, { type: "finish" }>): ChatStreamEvent => ({
  type: "chunk",
  chunk: value,
});
const thinking = (delta: string) => chunk({ type: "thinking_delta", delta });

export function populateChat(short = false): void {
  history = [
    UserMessage.create({
      id: "user",
      content: [TextBlock.create({ text: "Inspect the tool output." })],
      meta: new MessageMeta().set(ChatTimestampField, Date.now()),
    }),
    AssistantMessage.create({
      id: "response",
      ...fixtureModel,
      content: [
        TextBlock.create({
          text: Array.from({ length: short ? 1 : 35 }, (_, i) => `Result line ${i + 1}`).join(
            "\n\n",
          ),
        }),
      ],
    }),
  ];
  results = [];
  startRun([thinking("Starting…")]);
}

export function growActivity(): void {
  if (!run) startRun();
  emit(thinking("\nMore streamed reasoning…".repeat(20)));
}

export function setThoughtText(text: string): void {
  startRun([thinking(text)]);
}

export function finishChatActivity(): void {
  const content = run?.draft?.content ?? [];
  const meta = new MessageMeta().set(ChatDurationField, 3000);
  finishRun(AssistantMessage.create({ ...fixtureModel, content, meta }), results);
  results = [];
}

export function appendToolAndThought(): void {
  const output = "export const ready = true;\n".repeat(30);
  emit(chunk({ type: "tool_call_start", id: "read", name: "read" }));
  emit(
    chunk({
      type: "tool_call_end",
      id: "read",
      name: "read",
      arguments: JSON.stringify({ path: "src/example.ts" }),
    }),
  );
  const result = ToolResultMessage.create({
    toolCallId: "read",
    toolName: "read",
    content: [TextBlock.create({ text: output })],
  });
  results.push(result);
  emit({ type: "message", message: Message.serialize(result) });
  emit(thinking("Now checking the result.\n".repeat(40)));
}

export function appendAssistantText(): void {
  if (!run) startRun();
  emit(chunk({ type: "text_delta", delta: "\n\nMore response text.".repeat(20) }));
}

export function mountMenuChat(): void {
  menuHistory = true;
  mountChat();
}

export function switchMenuConversation(): void {
  menuHistory = false;
  scope.get(UiSessionsService).newSession();
}
