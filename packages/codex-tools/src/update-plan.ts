import { inject } from "@harness/di";
import { ToolCallService } from "@harness/tool-call";
import { shallowRef } from "reactivity";
import { updatePlanParameters, type UpdatePlanArgs } from "./parameters.ts";

const UPDATE_PLAN_DESCRIPTION =
  "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n";

export function useUpdatePlanTool(): void {
  const toolCall = inject(ToolCallService);
  const latestPlan = shallowRef<UpdatePlanArgs>();
  toolCall.useTool({
    name: "update_plan",
    description: UPDATE_PLAN_DESCRIPTION,
    parameters: updatePlanParameters,
    execute(plan) {
      latestPlan.value = plan;
      return "Plan updated";
    },
  });
}
