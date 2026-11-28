import { defineStateSyncContract, stateSync } from "@harness/state-sync";
import { UserMessage } from "@harness/llm";
import { defineRpcContract, rpc } from "@harness/rpc";
import { defineStreamContract, stream } from "@harness/stream";
import { z } from "zod";
import {
  ChatRunOptionsSchema,
  ChatRunStateSchema,
  type ChatMessagesPage,
  type ChatModel,
  type ChatStreamEvent,
} from "./types.ts";

export const ChatRpcContract = defineRpcContract("chat", {
  listModels: rpc.call(z.void(), z.custom<readonly ChatModel[]>()),
  listPresets: rpc.call(
    z.void(),
    z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        icon: z.object({ src: z.string(), monochrome: z.boolean().optional() }).optional(),
      }),
    ),
  ),
  loadMessages: rpc.call(
    z.object({ before: z.number().optional(), limit: z.number().optional() }).optional(),
    z.custom<ChatMessagesPage>(),
  ),
  configure: rpc.call(ChatRunOptionsSchema, z.void()),
  start: rpc.call(
    z.object({ modelId: z.string().optional(), presetId: z.string().optional() }).optional(),
    z.void(),
  ),
  abortRun: rpc.call(z.void(), z.void()),
  acknowledgeStatus: rpc.call(z.void(), z.void()),
});

export const ChatStreamContract = defineStreamContract("chat", {
  attachStream: stream.channel(z.void(), z.custom<ChatStreamEvent>()),
});

export const ChatStateSyncContract = defineStateSyncContract("chat", {
  pending: stateSync.array(UserMessage.schema),
  queue: stateSync.array(UserMessage.schema),
  status: stateSync.value(ChatRunStateSchema, { readonly: true }),
});
