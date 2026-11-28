import { log } from "../../log.ts";

log("evaluate:function-edit/format");

export function format(value: string): string {
  return `[${value}]`;
}
