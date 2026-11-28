/* UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Dropdown, ContextMenu. Adaptation: scope-owned dismissal and action execution after focus restoration. */
import { nextTick, onScopeDispose, watch, type Ref } from "vue";
import { findMenuAction, type MenuAction, type ResolvedMenuGroup } from "./menu.ts";

export function guardMenuComposition(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) event.stopPropagation();
}

export function guardMenuEscape(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) event.preventDefault();
}

export function useMenuInteraction(
  open: Ref<boolean>,
  groups: Ref<readonly ResolvedMenuGroup[]>,
  returnFocus: () => HTMLElement | undefined,
  restoreFocus: () => boolean,
  onError: (error: unknown) => void,
) {
  let pending: { path: readonly string[]; action: MenuAction } | undefined;
  let outside = false;
  let alive = true;
  let content: HTMLElement | undefined;

  watch(
    open,
    (value, _previous, cleanup) => {
      if (!value) return;
      outside = false;
      const blur = () => {
        outside = true;
        open.value = false;
      };
      const resize = () => {
        open.value = false;
      };
      window.addEventListener("blur", blur);
      window.addEventListener("resize", resize);
      cleanup(() => {
        window.removeEventListener("blur", blur);
        window.removeEventListener("resize", resize);
      });
    },
    { immediate: true },
  );
  watch(groups, async (value) => {
    if (!open.value) return;
    if (!value.length) {
      open.value = false;
      return;
    }
    await nextTick();
    if (open.value && content?.isConnected && document.activeElement === document.body) content.focus();
  });
  onScopeDispose(() => {
    alive = false;
  });

  return {
    opened(event: Event) {
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      content = target?.matches('[role="menu"]')
        ? target
        : target?.querySelector<HTMLElement>('[role="menu"]') ?? undefined;
      return content;
    },
    select(path: readonly string[]) {
      const action = findMenuAction(groups.value, path);
      if (!action) return;
      pending = { path, action };
    },
    outside() {
      outside = true;
    },
    closeAutoFocus(event: Event) {
      event.preventDefault();
      const selected = pending;
      pending = undefined;
      const shouldRestore = !outside && restoreFocus();
      const target = returnFocus();
      const closing = content;
      void nextTick(async () => {
        if (!alive || open.value) return;
        const focused = document.activeElement;
        if (
          shouldRestore &&
          target?.isConnected &&
          (focused === document.body || closing?.contains(focused))
        ) {
          target.focus({ preventScroll: true });
        }
        if (!selected) return;
        const current = findMenuAction(groups.value, selected.path);
        if (current?.run !== selected.action.run) return;
        try {
          await current.run();
        } catch (error) {
          onError(error);
        }
      });
    },
  };
}
