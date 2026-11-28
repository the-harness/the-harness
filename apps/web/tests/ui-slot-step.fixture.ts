import { defineUiSlot, type UiSlotNext } from "../../../packages/ui-workbench/src/slots.ts";
import { createApp, defineComponent, effectScope, h, onScopeDispose, ref, type Component } from "vue";

interface SlotProps {
  outlet: string;
  value: number;
  path: string;
}

const Slot = defineUiSlot<SlotProps>();

const Row = defineComponent({
  props: ["outlet", "value", "path", "label"],
  setup(props, { slots }) {
    const count = ref(0);
    return () => h("section", { "data-row": props.label }, [
      h("p", `${props.label}: ${props.value} ${props.path}`),
      h("button", { onClick: () => count.value++ }, `${props.label} count ${count.value}`),
      h("input", { "aria-label": `${props.label} note` }),
      slots.default?.(),
    ]);
  },
});

const Used = defineComponent({
  props: ["outlet", "value", "path"],
  setup(props, { slots }) {
    return () => h(Row, { ...props, label: "used" }, {
      default: () => slots.default?.({ value: props.value + 1, path: `${props.path}/used` }),
    });
  },
});

createApp({
  setup() {
    const values = ref({ left: 1, right: 20 });
    const showContribution = ref(true);
    const terminalLabel = ref("Result");
    const anchor = Slot.use(Used);
    let inserted: ReturnType<typeof effectScope> | undefined;
    const insert = (side: "before" | "after") => {
      inserted?.stop();
      inserted = effectScope();
      inserted.run(() => Slot.use(Used, { [side]: anchor }));
    };
    onScopeDispose(() => inserted?.stop());

    return () => h("main", [
      h("h1", "UI slot lifecycle"),
      h("p", "Type a note, then press ArrowUp to update that outlet without moving focus."),
      h("nav", [
        h("button", { onClick: () => insert("before") }, "Insert before"),
        h("button", { onClick: () => insert("after") }, "Insert after"),
        h("button", { onClick: () => inserted?.stop() }, "Remove inserted"),
        h("button", { onClick: () => showContribution.value = !showContribution.value }, "Toggle contribution"),
        h("button", { onClick: () => terminalLabel.value = "Updated" }, "Update terminal"),
      ]),
      h(Slot.Contribute, { position: { before: anchor } }, {
        default: ({ value, path, Next }: SlotProps & { Next: UiSlotNext<SlotProps> }) =>
          h(Next as Component, { value: value + 10, path: `${path}/scoped` }),
      }),
      showContribution.value ? h(Slot.Contribute, { position: { after: anchor } }, {
        default: ({ Next, ...props }: SlotProps & { Next: UiSlotNext<SlotProps> }) =>
          h(Row, { ...props, label: "contributed" }, {
            default: () => h(Next as Component, {
              value: props.value + 100,
              path: `${props.path}/contributed`,
            }),
          }),
      }) : null,
      ...(["left", "right"] as const).map((outlet) => h("article", {
        "aria-label": outlet,
        onKeydown: (event: KeyboardEvent) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            values.value[outlet]++;
          }
        },
      }, [
        h("h2", outlet),
        h(Slot, { outlet, value: values.value[outlet], path: outlet }, {
          default: (props: SlotProps) => h("output", `${terminalLabel.value}: ${props.value} ${props.path}`),
        }),
      ])),
    ]);
  },
}).mount("#app");
