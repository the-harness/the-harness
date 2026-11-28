import { log } from "../../log.ts";

log("evaluate:function-edit/service");

export class FunctionEditService {
  readonly name = "service";

  constructor() {
    log("construct:FunctionEditService");
  }
}
