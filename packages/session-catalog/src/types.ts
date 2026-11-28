import { z } from "zod";

export const SessionSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().optional(),
  createdAt: z.number(),
  modelId: z.string().optional(),
  presetId: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
