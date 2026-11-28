import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

test("native Quick Pick dispatches the chosen contributed task or external URI opener", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-internal-quick-picks-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "quick-pick-consumers");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "quick-pick-consumers",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(
    join(extension, "index.cjs"),
    `
const vscode = require("vscode");

exports.activate = ({ subscriptions }) => {
  let taskCount = 2;
  const opened = [];
  subscriptions.push(
    vscode.tasks.registerTaskProvider("fixture", {
      provideTasks() {
        return ["First", "Second"].slice(0, taskCount).map((source) => new vscode.Task(
          { type: "fixture", source }, vscode.TaskScope.Workspace, "Build", source,
          new vscode.ProcessExecution(process.execPath, [source]),
        ));
      },
    }),
    vscode.commands.registerCommand("pickFixture.taskCount", count => { taskCount = count; }),
    vscode.commands.registerCommand("pickFixture.open", uri => vscode.env.openExternal(
      vscode.Uri.parse(uri), { allowContributedOpeners: true },
    )),
    vscode.commands.registerCommand("pickFixture.opened", () => opened),
  );
  for (const [id, label] of [["preview", "Open in Preview"], ["default", "Open in Viewer"]]) {
    subscriptions.push(vscode.window.registerExternalUriOpener(id, {
      canOpenExternalUri() { return vscode.ExternalUriOpenerPriority.Default; },
      openExternalUri(uri, context) {
        opened.push({ id, uri: uri.toString(), sameSource: uri === context.sourceUri });
      },
    }, { schemes: ["https"], label }));
  }
};
`,
  );

  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "vscode-internal-quick-picks";
  const invoke = (command: string, ...args: unknown[]) =>
    host.executeCommand(session, command, ...args);
  const registered = Promise.withResolvers<void>();
  const unlisten = host.onMainThreadCall(async (id, method, args, request) => {
    try {
      const result =
        method.startsWith("tasks.") ||
        method === "window.showQuickPick" ||
        method === "env.openExternal"
          ? await page.evaluate(
              async ({ id, method, args }) =>
                (
                  await import("/tests/vscode-internal-quick-picks.fixture.ts")
                ).dispatchQuickPickConsumer(id, method, args),
              { id, method, args },
            )
          : undefined;
      host.resolveMainCall(request, result);
      if (method === "tasks.registerProvider") registered.resolve();
    } catch (error) {
      host.resolveMainCall(request, undefined, String(error));
      if (method === "tasks.registerProvider") registered.reject(error);
    }
  });
  try {
    await page.exposeFunction("invokeQuickPickConsumer", (command: string, args: unknown[]) =>
      invoke(command, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(async () => {
      const { openQuickPickConsumers } =
        await import("/tests/vscode-internal-quick-picks.fixture.ts");
      openQuickPickConsumers(
        (
          window as Window & {
            invokeQuickPickConsumer(command: string, args: unknown[]): Promise<unknown>;
          }
        ).invokeQuickPickConsumer,
      );
    });
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], { storageRoot: join(root, "storage") });
    await host.activateByEvent(session, "onStartupFinished");
    await registered.promise;

    const dialog = page.getByRole("dialog");
    const filter = dialog.getByRole("combobox");
    const runTask = () =>
      page.evaluate(async () =>
        (await import("/tests/vscode-internal-quick-picks.fixture.ts")).runTaskProvider(),
      );
    const actions = () =>
      page.evaluate(async () =>
        (await import("/tests/vscode-internal-quick-picks.fixture.ts")).pickedActions(),
      );
    const building = runTask();
    await expect(filter).toHaveAttribute("placeholder", "Select a task to run");
    await expect(dialog.getByText("Build", { exact: true })).toHaveCount(2);
    await filter.fill("second");
    await expect(dialog.getByText("First", { exact: true })).toHaveCount(0);
    await dialog.getByText("Second", { exact: true }).click();
    await building;
    expect((await actions()).tasks).toEqual([{ title: "Build", args: ["Second"] }]);

    const canceledTask = runTask();
    await filter.press("Escape");
    await canceledTask;
    await invoke("pickFixture.taskCount", 0);
    await runTask();
    expect((await actions()).tasks).toHaveLength(1);
    await invoke("pickFixture.taskCount", 1);
    await runTask();
    expect((await actions()).tasks).toEqual([
      { title: "Build", args: ["Second"] },
      { title: "Build", args: ["First"] },
    ]);
    await expect(dialog).toHaveCount(0);

    const uri = "https://example.test/page#section";
    const opening = invoke("pickFixture.open", uri);
    await expect(dialog.getByText("Open link with")).toBeVisible();
    await dialog.getByText("Open in Preview").click();
    expect(await opening).toBe(true);
    expect(await invoke("pickFixture.opened")).toEqual([{ id: "preview", uri, sameSource: true }]);

    const canceledOpening = invoke("pickFixture.open", uri);
    await filter.press("Escape");
    expect(await canceledOpening).toBe(false);
    expect((await actions()).browserLinks).toEqual([]);

    const browserOpening = invoke("pickFixture.open", uri);
    await dialog.getByText("Open in browser", { exact: true }).click();
    expect(await browserOpening).toBe(true);
    expect((await actions()).browserLinks).toEqual([uri]);
    expect(await invoke("pickFixture.opened")).toEqual([{ id: "preview", uri, sameSource: true }]);
  } finally {
    unlisten();
    await fixture.dispose(session);
    await rm(root, { recursive: true, force: true });
  }
});
