import { log } from "../../log.ts";
import Panel from "./Panel.vue";

log("evaluate:rebind-loop/workbench");

export function panelTitle(): string {
  return "rebind loop";
}

export function useWorkbench(): typeof Panel {
  return Panel;
}
