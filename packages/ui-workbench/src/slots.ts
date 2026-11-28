import { HookSlot, type HookAnchor, type HookPosition } from "@harness/hooks";
import {
  defineComponent,
  Fragment,
  h,
  markRaw,
  type Component,
  type DefineComponent,
  type FunctionalComponent,
  type SetupContext,
  type SlotsType,
  type VNodeChild,
} from "vue";

export type { HookAnchor, HookPosition };

export type UiSlotNext<TProps extends object = Record<string, never>> = FunctionalComponent<
  Partial<TProps>
>;

export interface UiSlotContributeProps {
  readonly position?: HookPosition;
}

export type UiSlotContribute<TProps extends object = Record<string, never>> = DefineComponent<
  UiSlotContributeProps,
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  string,
  UiSlotContributeProps,
  Readonly<UiSlotContributeProps>,
  {},
  SlotsType<{ default?: (scope: TProps & { readonly Next: UiSlotNext<TProps> }) => any }>
>;

export type UiSlotComponent<TProps extends object = Record<string, never>> = Component<
  TProps,
  any,
  any,
  {},
  {},
  {},
  SlotsType<{ default?: (overrides?: Partial<TProps>) => any }>
>;

export type UiSlot<TProps extends object = Record<string, never>> = FunctionalComponent<
  TProps,
  {},
  { default?: (props: TProps) => any }
> & {
  readonly Contribute: UiSlotContribute<TProps>;
  use(component: UiSlotComponent<TProps>, position?: HookPosition): HookAnchor;
};

interface UiSlotRenderContext<TProps extends object> {
  readonly slotProps: TProps;
  readonly Next: UiSlotNext<TProps>;
}

class UiSlotHooks<TProps extends object> extends HookSlot<UiSlotRenderContext<TProps>, VNodeChild> {
  at(index: number) {
    return this.entries[index]?.handler;
  }

  register(render: (context: UiSlotRenderContext<TProps>) => VNodeChild, position?: HookPosition) {
    const key = Symbol();
    return this.use((context) => h(Fragment, { key }, [render(context)]), position);
  }
}

export function defineUiSlot<TProps extends object = Record<string, never>>(): UiSlot<TProps> {
  const slot = new UiSlotHooks<TProps>();

  const Step = defineComponent({
    inheritAttrs: false,
    props: ["index", "slotProps", "terminal"],
    setup(props: {
      index: number;
      slotProps: TProps;
      terminal?: (props: TProps) => VNodeChild;
    }): () => VNodeChild {
      const Next: UiSlotNext<TProps> = (_props, { attrs }) =>
        h(Step, {
          index: props.index + 1,
          slotProps: { ...props.slotProps, ...attrs },
          terminal: props.terminal,
        });
      Next.inheritAttrs = false;

      return () => {
        const handler = slot.at(props.index);
        return handler === undefined
          ? props.terminal?.(props.slotProps) ?? null
          : handler({ slotProps: props.slotProps, Next }, () => h(Next));
      };
    },
  });

  const Root: FunctionalComponent<TProps, {}, { default?: (props: TProps) => any }> = (
    _props,
    { attrs, slots },
  ) =>
    h(Step, {
      index: 0,
      slotProps: { ...attrs } as TProps,
      terminal: slots.default,
    });
  Root.inheritAttrs = false;

  const Contribute = {
    props: ["position"],
    setup(props: UiSlotContributeProps, { slots }: SetupContext) {
      slot.register(
        ({ slotProps, Next }) => slots.default?.({ ...slotProps, Next }) ?? null,
        props.position,
      );
      return () => null;
    },
  } as unknown as UiSlotContribute<TProps>;

  return Object.assign(Root, {
    Contribute,
    use(component: UiSlotComponent<TProps>, position?: HookPosition): HookAnchor {
      const raw = markRaw(component);
      return slot.register(
        ({ slotProps, Next }) =>
          h(raw as Component, slotProps, {
            default: (overrides?: Partial<TProps>) => h(Next as Component, overrides),
          }),
        position,
      );
    },
  });
}

export const ChatHeaderSlot = defineUiSlot<{ readonly sessionId?: string }>();
export const ChatInputNotificationSlot = defineUiSlot<{ readonly sessionId?: string }>();
export const ChatComposerSlot = defineUiSlot<{ readonly sessionId?: string }>();
export const StatusBarSlot = defineUiSlot();
export const ViewProgressSlot = defineUiSlot<{ readonly viewId: string }>();
export const SettingsSlot = defineUiSlot();
export const AppearanceSettingsSlot = defineUiSlot();
