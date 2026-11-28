import { defineRpcContract, rpc } from "@harness/rpc";
import { SessionSummarySchema, type SessionSummary } from "@harness/session-catalog/types";
import { defineStateSyncContract, stateSync } from "@harness/state-sync";
import { ExtensibleFields } from "@harness/variants";
import { z } from "zod";

export class SessionMeta extends ExtensibleFields {}

export { SessionSummarySchema, type SessionSummary };

export interface SessionView {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly modelId?: string;
  readonly presetId?: string;
  readonly meta: SessionMeta;
}

export const SessionsStateSyncContract = defineStateSyncContract("sessions", {
  items: stateSync.array(z.custom<SessionSummary>(), { readonly: true }),
});

export const SessionsRpcContract = defineRpcContract("sessions", {
  create: rpc.call(z.object({ id: z.string(), workspaceId: z.string() }), z.void()),
  rename: rpc.call(z.object({ id: z.string(), title: z.string() }), z.void()),
  setMeta: rpc.call(
    z.object({ id: z.string(), meta: z.record(z.string(), z.unknown()).optional() }),
    z.void(),
  ),
  remove: rpc.call(z.object({ id: z.string() }), z.void()),
});
