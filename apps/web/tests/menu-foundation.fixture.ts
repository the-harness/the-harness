import { createRootScope, inject } from "@harness/di";
import { ActionMenu, ContextMenu, Menu, MenuGroup, MenuAction, MenuSubmenu } from "@harness/ui-menu";
import { variant } from "@harness/variants";
import { UiOutputService } from "@harness/ui-output";
import { computed, createApp, h, onScopeDispose, ref } from "vue";
import "../src/style.css";
import "virtual:uno.css";

@variant("test:ui-menu:inspect-output")
class InspectOutputAction extends MenuAction {}

interface DemoMenuContext { name: string; focusInput?: () => void }

class MenuDemoService {
  readonly menu = new Menu({
    view: (context: DemoMenuContext) => context.focusInput ? [
      new MenuAction({ id: "view-action", label: "Focus input", run: context.focusInput }),
    ] : [],
  });
  readonly positionMenu = new Menu({ position: (_context: DemoMenuContext) => [] });
  readonly pinned = ref(false);
  readonly position = ref("Left");
}

createApp({
  setup() {
    const root = createRootScope();
    const otherRoot = createRootScope();
    root.provideAll([MenuDemoService, UiOutputService]);
    otherRoot.provide(MenuDemoService);
    onScopeDispose(() => { root.dispose(); otherRoot.dispose(); });
    const service = root.get(MenuDemoService);
    const status = ref("No action yet");
    const output = root.get(UiOutputService);
    let channel!: ReturnType<UiOutputService["useChannel"]>;
    root.setup(() => {
      channel = output.useChannel("Extension example");
      channel.appendLine("Output remains available");
    });
    let extension = root.createChild();
    const extended = ref(false);
    const outputContext = { channelId: channel.id, selection: "selected text", selectAll: () => {} };
    const outputMenuGroups = computed(() => output.menu.resolve(outputContext));
    const toggleExtension = () => {
      if (extended.value) extension.dispose();
      else {
        extension = root.createChild();
        extension.setup(() => {
          output.menu.use((_context, next) => [...next()].reverse());
          output.menu.groups.output.use((_context, next) => next().filter((item) => item.id !== "clear"));
          output.menu.groups.clipboard.use((_context, next) => next().map((item) => item.id === "copy-all"
            ? new InspectOutputAction({ id: item.id, label: "Inspect Output", run: () => { status.value = "Inspected output"; } })
            : item));
        });
      }
      extended.value = !extended.value;
    };
    const owner = root.createChild();
    owner.setup(() => {
      const service = inject(MenuDemoService);
      const actions = new MenuGroup<DemoMenuContext>("actions");
      const layout = new MenuGroup<DemoMenuContext>("layout");
      service.menu.use((_context, next) => [...next(), actions, layout]);
      actions.use(({ name }, next) => [
        ...next(),
        new MenuAction({ id: "open", label: `Open ${name}`, icon: "i-codicon-go-to-file", shortcut: "Enter", run: () => { status.value = `Opened ${name}`; } }),
        new MenuAction({ id: "pin", type: "checkbox", label: "Pin", checked: service.pinned.value, run: () => { service.pinned.value = !service.pinned.value; } }),
        new MenuAction({ id: "hidden", label: "Hidden action", visible: false, run: () => {} }),
      ]);
      service.positionMenu.groups.position.use((_context, next) => [...next(), ...["Left", "Right"].map((position) => new MenuAction({
          id: position, type: "radio", label: position, checked: service.position.value === position,
          run: () => { service.position.value = position; status.value = `Side bar: ${position}`; },
      }))]);
      layout.use((_context, next) => [
        ...next(),
        new MenuSubmenu<DemoMenuContext>({ id: "layout", label: "Side Bar Position", menu: service.positionMenu }),
        new MenuAction({ id: "unavailable", label: "Rename", shortcut: "F2", disabled: true, run: () => {} }),
        new MenuSubmenu<DemoMenuContext>({ id: "empty", label: "Empty submenu", menu: new Menu({}) }),
      ]);
    });
    const detached = ref(false);
    const target = ref({ name: "README.md" });
    const menuGroups = computed(() => service.menu.resolve({
      ...target.value,
      focusInput: () => {
        status.value = `Input for ${target.value.name}`;
        document.querySelector<HTMLInputElement>('[aria-label="Outside field"]')?.focus();
      },
    }));
    const isolatedGroups = computed(() => otherRoot.get(MenuDemoService).menu.resolve(target.value));
    const menu = ref<InstanceType<typeof ContextMenu>>();
    return () => h("main", { style: "max-width: 720px; margin: 48px auto; padding: 24px; font-size: 13px" }, [
      h("h1", { style: "font-size: 20px; font-weight: 500" }, "Menu foundation"),
      h("p", { style: "color: var(--muted)" }, "Right-click a row, or focus it and press Shift+F10. Submenus support hover and arrow keys."),
      h("section", { style: "border: 1px solid var(--border); padding: 12px; border-radius: 5px; margin: 20px 0" }, [
        h(ContextMenu, { label: "Item actions", groups: service.menu.resolve({ name: "README.md" }) }, () =>
          h("button", { style: "display: block; width: 100%; padding: 8px; text-align: left" }, "README.md — right-click here")),
        h("button", {
          style: "display: block; width: 100%; padding: 8px; text-align: left",
          onContextmenu: (event: MouseEvent) => { target.value = { name: "package.json" }; menu.value?.show(event); },
          onKeydown: (event: KeyboardEvent) => {
            if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
              if (menuGroups.value.length) event.preventDefault();
              target.value = { name: "package.json" };
              menu.value?.show(event.currentTarget as HTMLElement);
            }
          },
        }, "package.json — explicit anchor"),
        h(ContextMenu, { ref: menu, label: "Anchored actions", groups: menuGroups.value }),
        h(ContextMenu, { label: "Background actions", groups: menuGroups.value }, () =>
          h("div", { style: "padding: 8px; color: var(--muted)" }, "Pane background")),
        h(ContextMenu, { label: "Nested actions", groups: menuGroups.value }, () =>
          h("section", [h("button", "Nested control")])),
      ]),
      h("div", { style: "display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px" }, [
        h(ActionMenu, { label: "File actions", groups: menuGroups.value, align: "start" }, () => "File actions ▾"),
        h(ActionMenu, { label: "Other workspace", groups: isolatedGroups.value }, () => "Other workspace (empty)"),
        h("button", { disabled: detached.value, onClick: () => { owner.dispose(); detached.value = true; } }, "Unload menu contribution"),
      ]),
      h(ActionMenu, { label: "Output actions", groups: outputMenuGroups.value }, () => "Output actions"),
      h("button", { onClick: toggleExtension }, extended.value ? "Unload output extension" : "Load output extension"),
      h("output", { "aria-label": "Action result", style: "display: block; color: var(--muted)" }, status.value),
      h("input", { "aria-label": "Outside field", placeholder: "Focus after dismissal", style: "margin-top: 20px" }),
    ]);
  },
}).mount("#app");
