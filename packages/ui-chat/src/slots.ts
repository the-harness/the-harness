import { defineUiSlot } from "@harness/ui-workbench";
import type { ChatBlock, SessionMessage } from "./types.ts";

export const ChatMessageSlot = defineUiSlot<{ readonly message: SessionMessage }>();
export const ChatBlockSlot = defineUiSlot<{ readonly block: ChatBlock }>();
export const ChatTurnFooterSlot = defineUiSlot<{ readonly message: SessionMessage }>();
