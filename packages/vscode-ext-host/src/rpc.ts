import { defineRpcContract, rpc } from "@harness/rpc";
import { defineStateSyncContract, stateSync } from "@harness/state-sync";
import { defineStreamContract, stream } from "@harness/stream";
import { z } from "zod";
import { ExtHostWireErrorSchema } from "./wire-error.ts";

export const ExtHostMainCallEventSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  method: z.string(),
  args: z.array(z.unknown()),
});

export type ExtHostMainCallEvent = z.infer<typeof ExtHostMainCallEventSchema>;

export const LegacyExtensionSecretsSchema = z.array(
  z.object({
    extensionId: z.string().min(1),
    key: z.string(),
    value: z.string(),
  }),
);

export const ExtHostRpcContract = defineRpcContract("extHost", {
  scanExtensions: rpc.call(
    z.object({ extensionsDir: z.string() }),
    z.array(z.custom<import("./manifest.ts").ExtensionManifest>()),
  ),
  removeContentExtension: rpc.call(z.object({ extensionId: z.string().min(1) }), z.boolean()),
  removeExtension: rpc.call(z.object({ extensionId: z.string().min(1) }), z.boolean()),
  getContributions: rpc.call(
    z.object({}),
    z.array(
      z.custom<
        import("@harness/vscode-editor-compat/contributions").ExtensionContributionSnapshot
      >(),
    ),
  ),
  startSession: rpc.call(
    z.object({
      sessionId: z.string(),
      workspaceRoots: z.array(z.string()),
      initialState: z.record(z.string(), z.unknown()).optional(),
    }),
    z.void(),
  ),
  stopSession: rpc.call(z.object({ sessionId: z.string() }), z.void()),
  activateByEvent: rpc.call(z.object({ sessionId: z.string(), event: z.string() }), z.void()),
  executeCommand: rpc.call(
    z.object({
      sessionId: z.string(),
      command: z.string(),
      args: z.array(z.unknown()).optional(),
    }),
    z.unknown(),
  ),
  syncMcpProvider: rpc.call(z.object({ sessionId: z.string(), providerId: z.string() }), z.void()),
  dropMcpProvider: rpc.call(z.object({ sessionId: z.string(), providerId: z.string() }), z.void()),
  importLegacySecrets: rpc.call(
    LegacyExtensionSecretsSchema,
    z.array(z.number().int().nonnegative()),
  ),
  resolveMainCall: rpc.call(
    z.object({
      sessionId: z.string(),
      requestId: z.string(),
      result: z.unknown().optional(),
      ...ExtHostWireErrorSchema.partial().shape,
    }),
    z.void(),
  ),
});

export const ExtHostStreamContract = defineStreamContract("extHost", {
  events: stream.channel(
    z.object({ sessionId: z.string() }),
    z.union([ExtHostMainCallEventSchema, z.object({ ready: z.literal(true) })]),
  ),
});

export const ExtHostStateSyncContract = defineStateSyncContract("extHost", {
  contributionsVersion: stateSync.value(z.string(), { readonly: true }),
});
