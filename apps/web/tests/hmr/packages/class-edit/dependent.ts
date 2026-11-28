import { inject } from "@harness/di";
import { log } from "../../log.ts";
import { ClassEditBase } from "./base.ts";

log("evaluate:class-edit/dependent");

export class ClassEditDependent {
  readonly base = inject(ClassEditBase);

  constructor() {
    log(`construct:ClassEditDependent:${this.base.version}`);
  }
}
