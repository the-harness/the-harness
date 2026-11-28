import { defineStateSyncContract, stateSync } from "@harness/state-sync";
import { ExtensibleVariants, variant } from "@harness/variants";
import { z } from "zod";

export interface UserInputOption {
  readonly label: string;
  readonly description?: string;
}

export interface UserInputQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly multiSelect?: boolean;
  readonly allowCustom?: boolean;
  readonly secret?: boolean;
  readonly options?: readonly UserInputOption[];
}

export interface UserInputAnswer {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

export interface UserInputResponse {
  readonly answers: readonly UserInputAnswer[];
}

export type InteractionResult<T = unknown> =
  | { readonly status: "resolved"; readonly data: T }
  | { readonly status: "cancelled"; readonly reason?: string };

// 可拓展基类：所有需要人类介入的挂起请求
export abstract class InteractionRequest extends ExtensibleVariants {}

@variant("core:interaction:user-input")
export class UserInputInteraction extends InteractionRequest {
  declare readonly callId?: string;
  declare readonly questions: readonly UserInputQuestion[];
}

export interface InteractionEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly request: InteractionRequest;
  readonly createdAt: number;
}

export const interactionEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  request: InteractionRequest.schema,
  createdAt: z.number(),
});

export const InteractionStateSyncContract = defineStateSyncContract("interaction", {
  active: stateSync.record(z.array(interactionEntrySchema), { readonly: true }),
});
