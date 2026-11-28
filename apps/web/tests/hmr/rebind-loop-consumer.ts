import { log } from "./log.ts";
import { useWorkbench } from "./packages/rebind-loop/workbench.ts";

log("evaluate:rebind-loop-consumer");
(globalThis as { __hmrClientRebindLoop?: typeof useWorkbench }).__hmrClientRebindLoop = useWorkbench;

if (import.meta.hot) import.meta.hot.accept();
