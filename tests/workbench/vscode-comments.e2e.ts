import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("extension comments display in the real panel and Monaco, preserve reply/action identity, reveal and dispose", async ({
  page,
}) => {
  const root = mkdtempSync(join(process.cwd(), "temp/artifacts/comments-ui-"));
  const extension = join(root, "extensions/probe");
  mkdirSync(extension, { recursive: true });
  const file = join(root, "sample.ts");
  writeFileSync(file, "first\nsecond\nthird");
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "fixture",
      name: "comments",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:comments.ready"],
      contributes: {
        commands: [
          { command: "comments.reply", title: "Reply to thread", enablement: "!commentIsEmpty" },
          { command: "comments.inspectAction", title: "%inspect.comment%" },
        ],
        menus: {
          "comments/commentThread/context": [
            { command: "comments.reply", when: "commentController == fixture.comments" },
          ],
          "comments/comment/title": [
            { command: "comments.inspectAction", when: "comment == fixture.comment" },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(extension, "package.nls.json"),
    JSON.stringify({ "inspect.comment": "Inspect comment" }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    String.raw`
    const v=require('vscode');let controller,thread,replySame=false,commentSame=false;
    exports.activate=context=>{
      controller=v.comments.createCommentController('fixture.comments','Fixture comments');context.subscriptions.push(controller);
      controller.options={prompt:'Your reply',placeHolder:'Reply here'};
      const comment={body:new v.MarkdownString('**Review this line**'),author:{name:'Reviewer'},mode:v.CommentMode.Preview,contextValue:'fixture.comment'};
      thread=controller.createCommentThread(v.Uri.file(${JSON.stringify(file)}),new v.Range(1,0,1,6),[comment]);thread.label='Sample review';thread.collapsibleState=v.CommentThreadCollapsibleState.Expanded;
      context.subscriptions.push(v.commands.registerCommand('comments.ready',()=>thread.reveal(comment,{focus:v.CommentThreadFocus.Comment})));
      context.subscriptions.push(v.commands.registerCommand('comments.reply',value=>{replySame=value.thread===thread;thread.comments=[...thread.comments,{body:value.text,author:{name:'You'},mode:v.CommentMode.Preview}]}));
      context.subscriptions.push(v.commands.registerCommand('comments.inspectAction',value=>{commentSame=value===comment}));
      context.subscriptions.push(v.commands.registerCommand('comments.result',()=>({replySame,commentSame,active:controller.activeCommentThread===thread,activeComment:controller.activeComment===comment,collapsed:thread.collapsibleState})));
      context.subscriptions.push(v.commands.registerCommand('comments.hide',()=>thread.hide()));
      context.subscriptions.push(v.commands.registerCommand('comments.dispose',()=>controller.dispose()));
    };
  `,
  );
  const errors = await captureBrowserErrors(page);
  await page.goto("/tests/vscode-empty.fixture.html");
  const fixture = await createBuiltinLanguageHost(root, async (session, method, args) => {
    if (!method.startsWith("comments.")) return { handled: false };
    return {
      handled: true,
      result: await page.evaluate(
        async ({ session, method, args }) =>
          (await import("/tests/vscode-comments.fixture.ts")).dispatchCommentsFixture(
            session,
            method,
            args,
          ),
        { session, method, args },
      ),
    };
  });
  await page.exposeFunction("invokeCommentCommand", (command: string, args: unknown[]) =>
    fixture.host.executeCommand("comments", command, ...args),
  );
  await page.evaluate(
    async (file) => (await import("/tests/vscode-comments.fixture.ts")).openCommentsFixture(file),
    file,
  );
  try {
    await fixture.host.scanExtensions(join(root, "extensions"));
    await fixture.host.startSession("comments", [root], { storageRoot: join(root, "storage") });
    await fixture.host.executeCommand("comments", "comments.ready");
    await expect(page.getByText("Review this line", { exact: true })).toBeVisible();
    await expect(page.locator('article[data-comment-id="1"]')).toBeFocused();
    const state = await page.evaluate(async () =>
      (await import("/tests/vscode-comments.fixture.ts")).inspectCommentsFixture(),
    );
    expect(state.workerCount).toBeGreaterThan(0);
    expect(state.selection).toMatchObject({
      startLineNumber: 2,
      endLineNumber: 2,
      startColumn: 1,
      endColumn: 7,
    });
    expect(state.decorations).toMatchObject([
      {
        range: { startLineNumber: 2, endLineNumber: 2 },
        hover: [{ value: expect.stringContaining("Review this line") }],
      },
    ]);
    const comment = page.locator('article[data-comment-id="1"]');
    await comment.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "Comment actions", exact: true });
    await expect(menu.getByRole("menuitem", { name: "Inspect comment", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(comment).toBeFocused();
    await comment.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Inspect comment", exact: true }).click();
    await expect
      .poll(() => fixture.host.executeCommand("comments", "comments.result"))
      .toMatchObject({ commentSame: true, active: true });
    await page.getByLabel("Your reply").fill("Reply from the real UI");
    await page.getByRole("button", { name: "Reply to thread" }).click();
    await expect(page.getByText("Reply from the real UI", { exact: true })).toBeVisible();
    await expect
      .poll(() => fixture.host.executeCommand("comments", "comments.result"))
      .toMatchObject({ replySame: true });
    await page.screenshot({ path: join(root, "comments-ui.png") });
    await fixture.host.executeCommand("comments", "comments.hide");
    await expect(page.getByText("Review this line", { exact: true })).not.toBeVisible();
    await page.getByRole("button", { name: "Expand comments" }).click();
    await expect
      .poll(() => fixture.host.executeCommand("comments", "comments.result"))
      .toMatchObject({ collapsed: 1 });
    await fixture.host.executeCommand("comments", "comments.dispose");
    await expect(page.getByText("No comments", { exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await import("/tests/vscode-comments.fixture.ts")).inspectCommentsFixture(),
        ),
      )
      .toMatchObject({ threads: 0, controllers: 0, decorations: [] });
  } finally {
    await fixture.dispose("comments");
    await page.evaluate(async () =>
      (await import("/tests/vscode-comments.fixture.ts")).closeCommentsFixture(),
    );
  }
  expect(fixture.errors).toEqual([]);
  expect(await errors()).toEqual([]);
});
