import { z } from "zod";

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly folders: readonly string[];
  readonly instructions: string;
}

export const WorkspaceSchema: z.ZodType<Workspace> = z.object({
  id: z.string(),
  name: z.string(),
  folders: z.array(z.string()).min(1),
  instructions: z.string(),
});
