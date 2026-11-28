import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const probe = `
const atImport = l10n.t("Hello {0}", "Ada");
function activate(context) {
  context.subscriptions.push(commands.registerCommand("audit." + name, async () => {
    await Promise.resolve();
    return {
      atImport,
      named: l10n.t("Count {count}", { count: 0 }),
      commented: l10n.t({ message: "Open", comment: ["open", "verb"] }),
      fallback: l10n.t("Missing {0}", false),
      blank: l10n.t("Blank"),
      uri: l10n.uri?.fsPath ?? null,
      uriTyped: l10n.uri instanceof Uri,
      bundleValue: l10n.bundle?.["Hello {0}"] ?? null,
    };
  }));
}
`;

it("loads each extension's localization bundle before its entry point runs", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-l10n-"));
  const extensions = join(root, "extensions");
  const regional = join(extensions, "regional", "translations");
  const base = join(extensions, "base", "translations");
  await Promise.all([regional, base].map((directory) => mkdir(directory, { recursive: true })));
  for (const [name, entry, prelude, exportActivate] of [
    [
      "regional",
      "extension.mjs",
      'import { commands, l10n, Uri } from "vscode";',
      "export { activate };",
    ],
    [
      "base",
      "extension.cjs",
      'const { commands, l10n, Uri } = require("vscode");',
      "exports.activate = activate;",
    ],
  ]) {
    const extension = join(extensions, name);
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({
        name,
        publisher: "audit",
        main: entry,
        l10n: "./translations",
        activationEvents: ["onStartupFinished"],
      }),
    );
    await writeFile(
      join(extension, entry),
      `${prelude}\nconst name = ${JSON.stringify(name)};\n${probe}\n${exportActivate}`,
    );
  }
  const regionalPath = join(regional, "bundle.l10n.fr-ca.json");
  const basePath = join(base, "bundle.l10n.fr.json");
  await writeFile(
    regionalPath,
    JSON.stringify({
      "Hello {0}": "Allô {0}",
      "Count {count}": "Total {count}",
      "Open/openverb": "Ouvrir",
      Blank: "",
    }),
  );
  await writeFile(join(base, "bundle.l10n.fr-ca.json"), "{");
  await writeFile(
    basePath,
    JSON.stringify({
      "Hello {0}": "Bonjour {0}",
      "Count {count}": "Nombre {count}",
      "Open/openverb": "Ouvre",
    }),
  );

  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const unlisten = host.onMainThreadCall(async (_id, _method, _args, request) => {
    host.resolveMainCall(request);
  });
  const run = async (session: string, language: string) => {
    await host.startSession(session, [root], {
      environment: { language },
      storageRoot: join(root, "storage"),
    });
    await host.activateByEvent(session, "onStartupFinished");
    return Promise.all(
      ["regional", "base"].map((name) => host.executeCommand(session, "audit." + name)),
    );
  };
  try {
    await host.scanExtensions(extensions);
    expect(await run("french", "fr-CA")).toEqual([
      {
        atImport: "Allô Ada",
        named: "Total 0",
        commented: "Ouvrir",
        fallback: "Missing false",
        blank: "",
        uri: regionalPath,
        uriTyped: true,
        bundleValue: "Allô {0}",
      },
      {
        atImport: "Bonjour Ada",
        named: "Nombre 0",
        commented: "Ouvre",
        fallback: "Missing false",
        blank: "Blank",
        uri: basePath,
        uriTyped: true,
        bundleValue: "Bonjour {0}",
      },
    ]);
    const english = {
      atImport: "Hello Ada",
      named: "Count 0",
      commented: "Open",
      fallback: "Missing false",
      blank: "Blank",
      uri: null,
      uriTyped: false,
      bundleValue: null,
    };
    expect(await run("english", "en-US")).toEqual([english, english]);
  } finally {
    unlisten();
    await fixture.dispose("french", "english");
    await rm(root, { recursive: true, force: true });
  }
});
