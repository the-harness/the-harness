import { log } from "../../log.ts";

log("evaluate:class-edit/base");

export class ClassEditBase {
  readonly version = "v1";

  constructor() {
    log(`construct:ClassEditBase:${this.version}`);
  }
}
