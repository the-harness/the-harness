import { inject } from "@harness/di";
import { FailedConstructionService } from "./service.ts";

export class FailedConstructionDependent {
  readonly service = inject(FailedConstructionService);
}
