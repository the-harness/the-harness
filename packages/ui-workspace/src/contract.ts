import { defineStateSyncContract, stateSync } from "@harness/state-sync";
import { z } from "zod";
import type { Workspace } from "@harness/workspace-catalog/types";

export { WorkspaceSchema } from "@harness/workspace-catalog/types";

export const WorkspaceStateSyncContract = defineStateSyncContract("workspaces", {
  items: stateSync.array(z.custom<Workspace>()),
});
