import { HookSlot, type HookAnchor, type HookHandler, type HookPosition, type HookTerminal } from "@harness/hooks";
import { ExtensibleVariants, variant, type VariantProps } from "@harness/variants";
import { getCurrentScope } from "reactivity";

/** Extensible: subclasses of built-in items retain their menu behavior. */
export abstract class MenuItem extends ExtensibleVariants {
  declare readonly id: string;
  declare readonly label: string;
  declare readonly icon?: string;
  declare readonly disabled?: boolean;
  declare readonly visible?: boolean;
}

@variant("core:ui-menu:action")
export class MenuAction extends MenuItem {
  declare readonly type?: "action" | "checkbox" | "radio";
  declare readonly shortcut?: string;
  declare readonly checked?: boolean;
  declare readonly danger?: boolean;
  declare readonly run: () => void | Promise<void>;

  constructor(props: VariantProps<MenuAction> & Pick<MenuAction, "run">) {
    super(props);
  }
}

@variant("core:ui-menu:submenu")
export class MenuSubmenu<TContext = void> extends MenuItem {
  declare readonly menu: Menu<TContext>;

  constructor(props: VariantProps<MenuSubmenu<TContext>>) {
    super(props);
  }
}

export interface ResolvedMenuItem {
  readonly item: MenuItem;
  readonly groups?: readonly ResolvedMenuGroup[];
}

export interface ResolvedMenuGroup {
  readonly id: string;
  readonly items: readonly ResolvedMenuItem[];
}

export class MenuGroup<TContext = void> {
  private readonly slot = new HookSlot<TContext, readonly MenuItem[]>();

  readonly id: string;
  private readonly defaults: HookTerminal<TContext, readonly MenuItem[]>;

  constructor(id: string, defaults: HookTerminal<TContext, readonly MenuItem[]> = () => []) {
    this.id = id;
    this.defaults = defaults;
  }

  use(handler: HookHandler<TContext, readonly MenuItem[]>, position?: HookPosition): HookAnchor {
    if (!getCurrentScope()?.active) throw new Error("MenuGroup.use() requires an active EffectScope");
    return this.slot.use(handler, position);
  }

  resolve(context: TContext): readonly MenuItem[] {
    return this.slot.run(context, this.defaults);
  }
}

export class Menu<TContext = void, TGroup extends string = string> {
  private readonly slot = new HookSlot<TContext, readonly MenuGroup<TContext>[]>();

  private readonly defaults: HookTerminal<TContext, readonly MenuGroup<TContext>[]>;

  readonly groups: Readonly<Record<TGroup, MenuGroup<TContext>>>;

  constructor(definitions: Record<TGroup, HookTerminal<TContext, readonly MenuItem[]>>) {
    this.groups = Object.freeze(Object.fromEntries(
      Object.entries<HookTerminal<TContext, readonly MenuItem[]>>(definitions)
        .map(([id, defaults]) => [id, new MenuGroup(id, defaults)]),
    )) as Readonly<Record<TGroup, MenuGroup<TContext>>>;
    this.defaults = () => Object.values<MenuGroup<TContext>>(this.groups);
  }

  use(handler: HookHandler<TContext, readonly MenuGroup<TContext>[]>, position?: HookPosition): HookAnchor {
    if (!getCurrentScope()?.active) throw new Error("Menu.use() requires an active EffectScope");
    return this.slot.use(handler, position);
  }

  resolve(context: TContext): readonly ResolvedMenuGroup[] {
    return this.slot.run(context, this.defaults).flatMap((group) => {
      const items = group.resolve(context).flatMap((item): ResolvedMenuItem[] => {
        if (item.visible === false) return [];
        if (item instanceof MenuSubmenu) {
          const groups = item.menu.resolve(context);
          return groups.length ? [{ item, groups }] : [];
        }
        return item instanceof MenuAction ? [{ item }] : [];
      });
      return items.length ? [{ id: group.id, items }] : [];
    });
  }
}

export function findMenuAction(
  groups: readonly ResolvedMenuGroup[],
  path: readonly string[],
): MenuAction | undefined {
  const group = groups.find((group) => group.id === path[0]);
  const entry = group?.items.find(({ item }) => item.id === path[1]);
  if (!entry || entry.item.disabled || entry.item.visible === false) return;
  if (entry.groups) return findMenuAction(entry.groups, path.slice(2));
  if (path.length === 2 && entry.item instanceof MenuAction) return entry.item;
}
