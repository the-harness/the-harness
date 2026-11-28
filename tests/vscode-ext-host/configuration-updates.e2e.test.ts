import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createMainThreadWorkspace } from "../../packages/vscode-ext-host/src/main-thread/workspace.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const source = `
const vscode = require("vscode");

exports.activate = ({ subscriptions }) => {
  const { workspace } = vscode;
  const document = workspace.textDocuments[0];
  const javascript = { languageId: "javascript" };
  const editor = scope => workspace.getConfiguration("editor", scope);
  const changes = [];
  const inspect = () => ({
    typescript: editor(document).get("tabSize"),
    javascript: editor(javascript).get("tabSize"),
    resource: editor(document.uri).get("tabSize"),
    insertsSpaces: editor(document).get("insertSpaces"),
    globalLanguage: editor(document).inspect("tabSize").globalLanguageValue,
    languageIds: editor().inspect("tabSize").languageIds.sort(),
  });
  subscriptions.push(
    workspace.onDidChangeConfiguration(event => {
      changes.push({
        general: event.affectsConfiguration("editor"),
        typescript: event.affectsConfiguration("editor.tabSize", document),
        javascript: event.affectsConfiguration("editor.tabSize", javascript),
        resource: event.affectsConfiguration("editor.tabSize", document.uri),
        other: event.affectsConfiguration("files"),
      });
    }),
    vscode.commands.registerCommand("fixture.configuration.read", () => ({ ...inspect(), changes })),
    vscode.commands.registerCommand("fixture.configuration.write", async input => {
      await editor(document).update(input.setting ?? "tabSize", input.value, input.target, input.override);
      return inspect();
    }),
  );
};
`;

it("writes language-scoped settings and keeps the newest configuration across extension host messages", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-config-"));
  try {
    const extension = join(root, "extensions", "configuration");
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "configuration",
        publisher: "fixture",
        version: "1.0.0",
        main: "./extension.cjs",
        activationEvents: ["onCommand:fixture.configuration.read"],
      }),
    );
    writeFileSync(join(extension, "extension.cjs"), source);

    const fixture = await createExtensionHostFixture();
    const session = "configuration";
    try {
      const [storage, configuration] = await Promise.all([
        fixture.modules.load<typeof import("../../packages/ui-storage/src/storage.ts")>(
          "/packages/ui-storage/src/storage.ts",
        ),
        fixture.modules.load<typeof import("../../packages/ui-config/src/index.ts")>(
          "/packages/ui-config/src/index.ts",
        ),
      ]);
      fixture.scope.provideAll([storage.UiStorageService, configuration.UiConfigService]);
      const config = fixture.scope.get(configuration.UiConfigService);
      fixture.scope.run(() =>
        config.useDefaults({ "[typescript][javascript]": { "editor.tabSize": 2 } }),
      );
      config.set("editor.tabSize", 4);
      config.set("[typescript]", { "editor.tabSize": 3, "editor.insertSpaces": false });
      config.set("[typescript]", { editor: { tabSize: 6, insertSpaces: true } }, "workspace");

      let revision = 0;
      const captureConfiguration = () => ({ ...config.snapshot(), revision: ++revision });
      const initial = captureConfiguration();
      const handleMain = createMainThreadWorkspace(
        {
          activeRoots: { value: [root] },
          getRoot: () => {
            throw new Error("Unexpected file access");
          },
        },
        config,
        undefined,
        captureConfiguration,
      );
      const off = fixture.service.onMainThreadCall(async (_session, method, args, id) => {
        try {
          const result = method.startsWith("workspace.")
            ? await handleMain(method, args)
            : undefined;
          fixture.service.resolveMainCall(id, result);
        } catch (error) {
          fixture.service.resolveMainCall(id, undefined, String(error));
        }
      });
      try {
        await fixture.service.scanExtensions(join(root, "extensions"));
        await fixture.service.startSession(session, [root], {
          configuration: initial,
          storageRoot: join(root, "storage"),
          documents: [
            {
              uri: { scheme: "file", path: join(root, "file.ts") },
              text: "",
              languageId: "typescript",
              version: 1,
              eol: 1,
            },
          ],
        });
        const read = () => fixture.service.executeCommand(session, "fixture.configuration.read");
        const write = (input: {
          setting?: string;
          value?: number | boolean;
          target: number;
          override?: boolean;
        }) => fixture.service.executeCommand(session, "fixture.configuration.write", input);

        expect(await read()).toEqual({
          typescript: 6,
          javascript: 2,
          resource: 4,
          insertsSpaces: true,
          globalLanguage: 3,
          languageIds: ["javascript", "typescript"],
          changes: [],
        });
        expect(await write({ value: 8, target: 1 })).toMatchObject({
          typescript: 6,
          resource: 4,
          globalLanguage: 8,
        });
        expect(await write({ target: 2, override: true })).toMatchObject({
          typescript: 8,
          insertsSpaces: true,
        });
        expect(await write({ value: 5, target: 1, override: false })).toMatchObject({
          typescript: 8,
          javascript: 2,
          resource: 5,
        });

        const latest = captureConfiguration();
        await fixture.service.executeCommand(session, "__config.sync", latest);
        await fixture.service.executeCommand(session, "__config.sync", initial);
        expect(await read()).toMatchObject({
          typescript: 8,
          resource: 5,
          changes: [
            { general: true, typescript: false, javascript: false, resource: false, other: false },
            { general: true, typescript: true, javascript: false, resource: false, other: false },
            { general: true, typescript: false, javascript: false, resource: true, other: false },
          ],
        });
        await Promise.all([
          write({ value: 9, target: 1, override: true }),
          write({ setting: "insertSpaces", value: true, target: 1, override: true }),
        ]);
        expect(config.snapshot()).toMatchObject({
          user: { "[typescript]": { "editor.tabSize": 9, "editor.insertSpaces": true } },
          workspace: { "[typescript]": { editor: { insertSpaces: true } } },
        });
      } finally {
        off();
      }
    } finally {
      await fixture.dispose(session);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
