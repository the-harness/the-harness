import { AgentPresetRegistry, type AgentPreset } from "@harness/agent-preset";
import { ChatSession } from "@harness/chat-session";
import { inject } from "@harness/di";
import { createKeyedQueue } from "@harness/gateway";
import { LlmService } from "@harness/llm";
import { RpcServerService } from "@harness/rpc";
import { SessionManager } from "@harness/session-manager";
import { StateSyncServerService } from "@harness/state-sync";
import { StreamServerService } from "@harness/stream";
import { ChatRpcContract, ChatStateSyncContract, ChatStreamContract } from "../contract.ts";
import type { ChatPreset } from "../types.ts";

// Session calls reach the session scope through the transport routing set up by useSessionsHandlers.
export function useChatHandlers(): void {
  const llm = inject(LlmService);
  const presets = inject(AgentPresetRegistry);
  const listings = {
    listModels: () => llm.models.map(({ id, name, provider }) => ({ id, name, provider })),
    listPresets: () => [...presets.presets.values()].map(toChatPreset),
  };
  inject(RpcServerService).useHandlers(ChatRpcContract, listings);

  inject(SessionManager).useSessionSetup(() => {
    const session = inject(ChatSession);
    const acknowledgements = createKeyedQueue();
    inject(StateSyncServerService).useHandlers(ChatStateSyncContract, {
      pending: () => session.pending,
      queue: () => session.queue,
      status: () => session.status,
    });
    inject(RpcServerService).useHandlers(ChatRpcContract, {
      ...listings,
      loadMessages: (input) => session.loadMessages(input),
      configure: (input) => session.configure(input),
      start: (input) => session.start(input),
      abortRun: () => void session.abort(),
      acknowledgeStatus: (_input, ctx) =>
        acknowledgements.run("", async () => {
          ctx.signal?.throwIfAborted();
          return session.acknowledgeStatus();
        }),
    });
    inject(StreamServerService).useHandlers(ChatStreamContract, {
      attachStream: (_input, ctx) => session.attach(ctx.signal),
    });
  });
}

function toChatPreset({ id, name, description, icon }: AgentPreset): ChatPreset {
  return { id, name, description, icon };
}
