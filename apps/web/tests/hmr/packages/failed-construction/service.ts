import { log } from "../../log.ts";

export class FailedConstructionService {
  readonly version = "v1";

  constructor() {
    log(`construct:FailedConstructionService:${this.version}`);
  }
}
