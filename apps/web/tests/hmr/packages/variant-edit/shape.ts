import { ExtensibleVariants, variant } from "@harness/variants";

@variant("fixture:hmr-client:circle")
export class HmrCircle extends ExtensibleVariants {
  declare readonly radius: number;

  describe(): string {
    return `v1:${this.radius}`;
  }
}
