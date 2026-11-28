import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { deserializeValue, serializeValue } from "@harness/variants";
import { createApp, h } from "vue";
import { ClassEditBase } from "./packages/class-edit/base.ts";
import { ClassEditDependent } from "./packages/class-edit/dependent.ts";
import { FailedConstructionDependent } from "./packages/failed-construction/dependent.ts";
import { FailedConstructionService } from "./packages/failed-construction/service.ts";
import { FunctionEditService } from "./packages/function-edit/service.ts";
import { HmrCircle } from "./packages/variant-edit/shape.ts";
import "./packages/variant-edit/consumer.ts";
import { VueEditService } from "./packages/vue-edit/service.ts";
import "./function-edit-consumer.ts";
import "./rebind-loop-consumer.ts";
import VueEditProbe from "./VueEditProbe.vue";

type Circle = InstanceType<typeof HmrCircle>;

declare global {
  interface Window {
    __hmrClient: ReturnType<typeof createProbes>;
    __hmrClientLog?: string[];
    __hmrClientRender?: (service: { readonly name: string }) => string;
    __hmrClientCircle?: typeof HmrCircle;
    __hmrClientNoReload?: boolean;
  }
}

function createProbes() {
  const scope = createRootScope();
  scope.provideAll([
    ClassEditBase,
    ClassEditDependent,
    FunctionEditService,
    FailedConstructionService,
    FailedConstructionDependent,
    VueEditService,
  ]);
  const host = document.createElement("div");
  document.body.append(host);
  createApp({
    setup() {
      provideScope(scope);
      return () => h(VueEditProbe);
    },
  }).mount(host);
  // Through consumer.ts: holding the class here (static access) would make a class edit re-run this
  // entry, which nothing above accepts, and reload the page.
  const circle = globalThis.__hmrClientCircle!.create({ radius: 2 } as never) as Circle;
  return {
    scope,
    initial: {
      classEditBase: scope.get(ClassEditBase),
      classEditDependent: scope.get(ClassEditDependent),
      functionEditService: scope.get(FunctionEditService),
      failedConstructionService: scope.get(FailedConstructionService),
      circle,
      serializedCircle: serializeValue(circle),
    },
    classEditBase: () => scope.get(ClassEditBase),
    classEditDependent: () => scope.get(ClassEditDependent),
    functionEditService: () => scope.get(FunctionEditService),
    failedConstructionService: () => scope.get(FailedConstructionService),
    failedConstructionDependent: () => scope.get(FailedConstructionDependent),
    vueEditService: () => scope.get(VueEditService),
    InitialCircle: HmrCircle,
    deserialize: (raw: unknown) => deserializeValue(raw) as Circle,
  };
}

export function setup(): void {
  window.__hmrClient = createProbes();
  window.__hmrClientNoReload = true;
}
