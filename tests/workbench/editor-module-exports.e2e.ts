import { expect, test } from "@playwright/test";

test("re-evaluating editor services preserves unchanged helper exports", async ({ page }) => {
  await page.goto("/tests/editor-module-exports.fixture.html");
  const packages = new URL("../../packages/", import.meta.url).pathname;
  const urls = {
    editor: `/@fs${packages}ui-editor/src/index.ts`,
    workspace: `/@fs${packages}ui-workspace/src/index.ts`,
  };
  const identities = await page.evaluate(async ({ editor, workspace }) => {
    const beforeEditor = await import(editor);
    const beforeWorkspace = await import(workspace);
    const afterEditor = await import(`${editor}?t=${Date.now()}`);
    const afterWorkspace = await import(`${workspace}?t=${Date.now()}`);
    return {
      editorServiceWasReevaluated: beforeEditor.FileEditorService !== afterEditor.FileEditorService,
      workspaceServiceWasReevaluated:
        beforeWorkspace.UiWorkspaceService !== afterWorkspace.UiWorkspaceService,
      sameLanguageInference: beforeEditor.inferLanguage === afterEditor.inferLanguage,
      sameNodeIdEncoder: beforeWorkspace.workspaceNodeId === afterWorkspace.workspaceNodeId,
      sameNodeIdDecoder:
        beforeWorkspace.parseWorkspaceNodeId === afterWorkspace.parseWorkspaceNodeId,
    };
  }, urls);

  expect(identities).toEqual({
    editorServiceWasReevaluated: true,
    workspaceServiceWasReevaluated: true,
    sameLanguageInference: true,
    sameNodeIdEncoder: true,
    sameNodeIdDecoder: true,
  });
});
