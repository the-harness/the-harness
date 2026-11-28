import { captureBrowserErrors } from "../helpers/browser-errors.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

test("tree focus, selection, checkbox and commands preserve extension element identity through the real UI", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "tree-events-"));
  const extension = join(root, "extensions/fixture");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "regression",
      name: "tree-events",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:tree.ready"],
    }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    `
    const vscode = require('vscode');
    exports.activate = context => {
      let changed, invoked, invocations = 0;
      let invokedWithSelection;
      const selections = [];
      const label = entry => entry?.label;
      let revision = 0, delayNext = false, finishDelayed, removed = false;
      const refresh = new vscode.EventEmitter();
      class Item extends vscode.TreeItem {
        #value;
        constructor() {
          super(revision ? 'Updated item' : 'Fixture item');
          this.id = 'item';
          this.#value = 43 + revision;
          this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
          this.command = { command: 'tree.invoke', title: 'Invoke', arguments: [this] };
        }
        value() { return this.#value; }
      }
      const treeDataProvider = {
        onDidChangeTreeData: refresh.event,
        getChildren(parent) {
          if (removed) return [];
          if (parent?.id === 'nested') return [new Item()];
          if (parent?.id === 'root') {
            const group = new vscode.TreeItem('Nested folder', vscode.TreeItemCollapsibleState.Expanded);
            group.id = 'nested';
            return [group];
          }
          const root = new vscode.TreeItem(revision ? 'Renamed branch' : 'Fixture branch', vscode.TreeItemCollapsibleState.Collapsed);
          root.id = 'root';
          if (delayNext) {
            delayNext = false;
            return new Promise(resolve => { finishDelayed = () => resolve([root]); });
          }
          return [root];
        },
        getTreeItem: item => item,
      };
      const view = vscode.window.createTreeView('fixture.tree', { treeDataProvider });
      const multi = vscode.window.createTreeView('fixture.multi', {
        canSelectMany: true,
        treeDataProvider: {
          getChildren: () => ['First', 'Second', 'Third', 'Fourth'],
          getTreeItem: name => new vscode.TreeItem(name),
        },
      });
      context.subscriptions.push(refresh, view, view.onDidChangeCheckboxState(event => { changed = event.items.map(([entry,state]) => [entry.value(),state]); }));
      context.subscriptions.push(multi, view.onDidChangeSelection(event => {
        selections.push(event.selection.map(label));
      }));
      context.subscriptions.push(vscode.commands.registerCommand('tree.invoke', entry => {
        invoked = entry.value();
        invokedWithSelection = view.selection[0] === entry;
        invocations++;
      }));
      context.subscriptions.push(vscode.commands.registerCommand('tree.ready', () => vscode.commands.executeCommand('fixture.tree.focus')));
      context.subscriptions.push(vscode.commands.registerCommand('tree.result', () => ({
        changed, invoked, invocations, invokedWithSelection, waiting: !!finishDelayed,
        selection: view.selection.map(label), selections, multiple: [...multi.selection],
      })));
      context.subscriptions.push(vscode.commands.registerCommand('tree.delay', () => { delayNext = true; refresh.fire(); }));
      context.subscriptions.push(vscode.commands.registerCommand('tree.refresh', () => { revision++; refresh.fire(); }));
      context.subscriptions.push(vscode.commands.registerCommand('tree.finish', () => { finishDelayed(); finishDelayed = undefined; }));
      context.subscriptions.push(vscode.commands.registerCommand('tree.remove', () => { removed = true; refresh.fire(); }));
    };
  `,
  );
  const getBrowserErrors = await captureBrowserErrors(page);
  await page.goto("/");
  const fixture = await createBuiltinLanguageHost(root, async (session, method, args) => {
    if (!method.startsWith("tree.")) return { handled: false };
    return {
      handled: true,
      result: await page.evaluate(
        async ({ session, method, args }) =>
          (await import("/tests/vscode-tree.fixture.ts")).dispatchTreeFixture(
            session,
            method,
            args,
          ),
        { session, method, args },
      ),
    };
  });
  await page.exposeFunction("invokeBuiltinTreeCommand", (command: string, args: unknown[]) =>
    fixture.host.executeCommand("tree", command, ...args),
  );
  await page.evaluate(async () =>
    (await import("/tests/vscode-tree.fixture.ts")).openTreeFixture("tree"),
  );
  try {
    await fixture.host.scanExtensions(join(root, "extensions"));
    await fixture.host.startSession("tree", [root], { storageRoot: join(root, "host-storage") });
    await fixture.host.executeCommand("tree", "tree.ready");
    await expect(page.locator('[data-tree-view="fixture.tree"]')).toBeFocused();
    const branch = page.getByRole("button", { name: "Fixture branch" });
    await expect(branch).toHaveAttribute("aria-expanded", "false");
    const originalBranch = await branch.elementHandle();
    await branch.click();
    await expect(page.getByRole("button", { name: "Nested folder" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const panel = page.locator(".ext-tree-views");
    const treeBounds = await panel.boundingBox();
    const branchBounds = await branch.boundingBox();
    const nestedBounds = await page.getByRole("button", { name: "Nested folder" }).boundingBox();
    expect(branchBounds!.x - treeBounds!.x).toBe(0);
    expect(branchBounds!.width).toBe(treeBounds!.width);
    expect(nestedBounds!.x - branchBounds!.x).toBe(8);
    await page.getByRole("checkbox", { name: "Fixture item" }).check();
    await expect
      .poll(() => fixture.host.executeCommand("tree", "tree.result"))
      .toMatchObject({ changed: [[43, 1]] });
    await page.getByRole("button", { name: "Fixture item" }).click();
    await expect
      .poll(() => fixture.host.executeCommand("tree", "tree.result"))
      .toMatchObject({
        invoked: 43,
        invokedWithSelection: true,
        selection: ["Fixture item"],
        selections: [["Fixture branch"], ["Fixture item"]],
      });
    await expect(page.getByRole("treeitem").filter({ hasText: "Fixture item" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: "Fixture item" }).click();
    await expect
      .poll(() => fixture.host.executeCommand("tree", "tree.result"))
      .toMatchObject({
        invocations: 2,
        selections: [["Fixture branch"], ["Fixture item"]],
      });

    const multi = page.locator('[data-tree-view="fixture.multi"]');
    await multi.getByRole("button", { name: "First" }).click();
    await multi.getByRole("button", { name: "Third" }).click({ modifiers: ["Shift"] });
    await expect
      .poll(() => fixture.host.executeCommand("tree", "tree.result"))
      .toMatchObject({ multiple: ["First", "Second", "Third"] });
    await multi.getByRole("button", { name: "Second" }).click({ modifiers: ["ControlOrMeta"] });
    await expect
      .poll(() => fixture.host.executeCommand("tree", "tree.result"))
      .toMatchObject({ multiple: ["First", "Third"], selection: ["Fixture item"] });
    await fixture.host.executeCommand("tree", "tree.delay");
    await expect
      .poll(() => fixture.host.executeCommand("tree", "tree.result"))
      .toMatchObject({
        waiting: true,
      });
    await fixture.host.executeCommand("tree", "tree.refresh");
    const renamedBranch = page.getByRole("button", { name: "Renamed branch" });
    await expect(renamedBranch).toHaveAttribute("aria-expanded", "true");
    expect(
      await renamedBranch.evaluate((element, original) => element === original, originalBranch),
    ).toBe(true);
    await fixture.host.executeCommand("tree", "tree.finish");
    await expect
      .poll(() => fixture.host.executeCommand("tree", "tree.result"))
      .toMatchObject({
        selection: ["Updated item"],
        selections: [["Fixture branch"], ["Fixture item"]],
      });
    const updated = page.getByRole("button", { name: "Updated item" });
    await updated.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "Tree item actions", exact: true });
    await expect(menu.getByRole("menuitem", { name: "Open", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(updated).toBeFocused();
    await updated.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Open", exact: true }).click();
    await expect
      .poll(() => fixture.host.executeCommand("tree", "tree.result"))
      .toMatchObject({
        invoked: 44,
      });
    await expect(branch).toHaveCount(0);
    const getChildren = (...args: string[]) =>
      fixture.host.executeCommand<{ id: string }[]>(
        "tree",
        "__tree.getChildren.fixture.tree",
        ...args,
      );
    const [rootNode] = await getChildren();
    const [nested] = await getChildren(rootNode!.id);
    const [leaf] = await getChildren(nested!.id);
    await updated.click({ button: "right" });
    await fixture.host.executeCommand("tree", "tree.remove");
    await expect(menu).toBeHidden();
    await expect(renamedBranch).toHaveCount(0);
    await expect(getChildren(nested!.id)).resolves.toEqual([]);
    expect(
      await fixture.host.executeCommand("tree", "__tree.selection.fixture.tree", [leaf!.id]),
    ).toBe(false);
    await fixture.host.executeCommand("tree", "__tree.execute.fixture.tree", leaf!.id);
    expect(await fixture.host.executeCommand("tree", "tree.result")).toMatchObject({
      invocations: 3,
      selection: [],
      selections: [["Fixture branch"], ["Fixture item"], []],
    });
  } finally {
    await fixture.dispose("tree");
    await page.evaluate(async () =>
      (await import("/tests/vscode-tree.fixture.ts")).closeTreeFixture(),
    );
    rmSync(root, { recursive: true, force: true });
  }
  expect(fixture.errors).toEqual([]);
  expect(await getBrowserErrors()).toEqual([]);
});
