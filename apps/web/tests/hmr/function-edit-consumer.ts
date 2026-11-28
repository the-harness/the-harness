import { log } from "./log.ts";
import { render } from "./packages/function-edit/view.ts";

log("evaluate:function-edit-consumer");
(globalThis as { __hmrClientRender?: typeof render }).__hmrClientRender = render;

if (import.meta.hot) import.meta.hot.accept();
