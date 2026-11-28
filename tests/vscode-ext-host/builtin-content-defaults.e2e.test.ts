import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const builtins =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  process.env.HARNESS_VSCODE_BUILTINS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

it.skipIf(!existsSync(join(builtins, "theme-defaults/package.json")))(
  "reads every installed content-only configuration default through real language-scoped extension configuration",
  async () => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "builtin-content-defaults-"));
    const plans = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../fixtures/vscode-builtin-content-cases.json", import.meta.url)),
        "utf8",
      ),
    ) as { id: string; directory: string }[];
    const requests: {
      extensionId: string;
      languageId?: string;
      key: string;
      expected: unknown;
      manifestPath: string;
    }[] = [];
    for (const plan of plans) {
      const manifestPath = join(builtins, plan.directory, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const defaults = manifest.contributes?.configurationDefaults;
      if (!defaults) continue;
      const target = join(root, plan.directory);
      mkdirSync(target);
      symlinkSync(manifestPath, join(target, "package.json"));
      for (const [key, value] of Object.entries(defaults)) {
        const languages = [...key.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]!);
        if (languages.length) {
          for (const languageId of languages)
            for (const [setting, expected] of Object.entries(value as Record<string, unknown>))
              requests.push({
                extensionId: plan.id,
                languageId,
                key: setting,
                expected,
                manifestPath,
              });
        } else requests.push({ extensionId: plan.id, key, expected: value, manifestPath });
      }
    }
    const extension = join(root, "audit-defaults");
    mkdirSync(extension);
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        publisher: "audit",
        name: "content-defaults",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:audit.contentDefaults"],
      }),
    );
    writeFileSync(
      join(extension, "extension.cjs"),
      `
    const vscode = require("vscode");
    exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand("audit.contentDefaults", requests => requests.map(request => {
      const config = vscode.workspace.getConfiguration(undefined, request.languageId ? { languageId: request.languageId } : undefined);
      return { ...request, actual: config.get(request.key), inspection: config.inspect(request.key) };
    })));
  `,
    );
    const fixture = await createExtensionHostFixture();
    const off = fixture.service.onMainThreadCall(async (_session, _method, _args, requestId) => {
      if (requestId) fixture.service.resolveMainCall(requestId);
    });
    try {
      await fixture.service.scanExtensions(root);
      await fixture.service.startSession("content-defaults", [root]);
      const results = await fixture.service.executeCommand<
        ((typeof requests)[number] & {
          actual: unknown;
          inspection: { defaultLanguageValue?: unknown; defaultValue?: unknown };
        })[]
      >("content-defaults", "audit.contentDefaults", requests);
      writeFileSync(
        join(artifacts, "builtin-content-defaults-results.json"),
        JSON.stringify(
          {
            testedAt: new Date().toISOString(),
            extensions: [...new Set(results.map((result) => result.extensionId))],
            results,
          },
          null,
          2,
        ) + "\n",
      );
      expect(new Set(results.map((result) => result.extensionId)).size).toBe(16);
      for (const result of results) {
        expect(
          result.actual,
          `${result.extensionId}: [${result.languageId ?? "global"}] ${result.key}`,
        ).toEqual(result.expected);
        expect(
          result.languageId
            ? result.inspection.defaultLanguageValue
            : result.inspection.defaultValue,
          `${result.extensionId}: inspect ${result.key}`,
        ).toEqual(result.expected);
      }
    } finally {
      await fixture.dispose("content-defaults");
      off();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
