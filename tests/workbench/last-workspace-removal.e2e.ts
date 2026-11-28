import { expect, test } from "@playwright/test";

test("deleting the last workspace restores the default selection and removes its sessions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/last-workspace-removal-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("/last-workspace-removal-fixture");
  await page.evaluate(async () =>
    (await import("/tests/last-workspace-removal.fixture.ts")).mountConversations(),
  );

  const conversations = page.getByRole("tree", { name: "Conversations", exact: true });
  const workspace = conversations.getByRole("treeitem", { name: /^Only workspace\b/ });
  await expect(
    conversations.getByRole("treeitem", { name: /^Bound conversation\b/ }),
  ).toBeVisible();
  let confirmation = "";
  page.once("dialog", async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await workspace.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete workspace…", exact: true }).click();

  await expect(page.getByRole("status")).toHaveText("No conversations yet.");
  expect(confirmation).toBe("Delete “Only workspace” and its conversation?");
  const state = await page.evaluate(async () =>
    (await import("/tests/last-workspace-removal.fixture.ts")).readState(),
  );
  expect(state).toEqual({
    activeWorkspace: "default",
    activeSession: "",
    workspaceCount: 0,
    sessionCount: 0,
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("harness:core:ui-workspace:local");
        return JSON.parse(raw ?? "{}").activeWorkspaceId;
      }),
    )
    .toBe("default");
  expect(errors).toEqual([]);
});
