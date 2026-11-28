import { log } from "../../log.ts";
import { format } from "./format.ts";

log("evaluate:function-edit/view");

export function render(service: { readonly name: string }): string {
  return format(service.name);
}
