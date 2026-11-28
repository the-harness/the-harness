import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const probe = String.raw`
const v = require("vscode");
exports.activate = ({ subscriptions }) => {
  subscriptions.push(v.workspace.registerTextDocumentContentProvider("signature-fixture", {
    provideTextDocumentContent: () => "call(a,",
  }));
  subscriptions.push(v.languages.registerSignatureHelpProvider({
    language: "plaintext", scheme: "signature-fixture", pattern: "**/extension.sig",
  }, {
    provideSignatureHelp(doc, pos, token, context) {
      if (doc !== v.workspace.textDocuments.find(item => item.uri.toString() === doc.uri.toString()) ||
          doc.getText() !== "call(a," || pos.character !== 7 || token.isCancellationRequested ||
          context.triggerKind !== v.SignatureHelpTriggerKind.Invoke || context.triggerCharacter !== "," ||
          context.isRetrigger)
        throw new Error("Unexpected extension signature query");
      const markdown = new v.MarkdownString("**call**", true);
      markdown.isTrusted = { enabledCommands: ["fixture.signature"] };
      markdown.baseUri = v.Uri.parse("signature-fixture://docs/guide?version=2#call");
      const signature = new v.SignatureInformation("call(a, b)", markdown);
      signature.activeParameter = 1;
      signature.parameters = [new v.ParameterInformation([8, 9], "second parameter")];
      const help = new v.SignatureHelp();
      help.signatures = [new v.SignatureInformation("call()"), signature];
      help.activeSignature = 1;
      help.activeParameter = 0;
      return help;
    },
  }, ","));
  subscriptions.push(v.commands.registerCommand("fixture.signature", async name => {
    const uri = name === "file" ? v.Uri.joinPath(v.workspace.workspaceFolders[0].uri, "file.sig")
      : v.Uri.parse("signature-fixture://workspace/" + name + ".sig?view=2#anchor");
    const value = await v.commands.executeCommand("vscode.executeSignatureHelpProvider", uri, new v.Position(0, 7), ",");
    if (!value) return null;
    const signature = value.signatures[value.activeSignature];
    const documentation = signature.documentation;
    return {
      typed: value instanceof v.SignatureHelp && signature instanceof v.SignatureInformation &&
        signature.parameters.every(parameter => parameter instanceof v.ParameterInformation),
      label: signature.label,
      documentation: documentation && {
        typed: documentation instanceof v.MarkdownString,
        value: documentation.value, trusted: documentation.isTrusted,
        icons: documentation.supportThemeIcons, uri: documentation.baseUri?.toString(),
      },
      activeSignature: value.activeSignature, activeParameter: value.activeParameter,
      signatureParameter: signature.activeParameter, parameters: signature.parameters,
    };
  }));
};
`;

test("returns typed signature help for cold virtual documents and file working copies", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-signature-command-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "fixture");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "fixture",
      name: "signature",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(join(extension, "index.cjs"), probe);
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "signature-help-command";
  const registration = Promise.withResolvers<void>();
  const module = "/tests/vscode-provider-commands.fixture.ts";
  const unlisten = host.onMainThreadCall(async (id, method, args, request) => {
    try {
      let result: unknown;
      if (method.startsWith("languages.") || method === "workspace.openTextDocument") {
        result = await page.evaluate(
          async ({ module, id, method, args }) =>
            (await import(module)).dispatchProviderCommand(id, method, args),
          { module, id, method, args },
        );
      } else if (method === "workspace.resolveDocumentLanguage") {
        result = "plaintext";
      } else if (method === "commands.execute") {
        throw new Error(`Command '${args[0]}' not found`);
      }
      host.resolveMainCall(request, result);
      if (method === "languages.registerProvider") registration.resolve();
    } catch (error) {
      host.resolveMainCall(request, undefined, String(error));
      if (method === "languages.registerProvider") registration.reject(error);
    }
  });
  try {
    await page.exposeFunction(
      "invokeSignatureProvider",
      (id: string, command: string, args: unknown[]) => host.executeCommand(id, command, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    const fileUri = Uri.file(join(root, "file.sig")).toJSON();
    await page.evaluate(
      async ({ module, snapshot, fileUri }) => {
        (await import(module)).openProviderCommandModel(
          snapshot,
          (
            window as unknown as {
              invokeSignatureProvider(
                id: string,
                command: string,
                args: unknown[],
              ): Promise<unknown>;
            }
          ).invokeSignatureProvider,
          [{ ...snapshot, uri: fileUri, text: "call(a,", isDirty: true }],
        );
        (
          await import("/tests/vscode-signature-help-command.fixture.ts")
        ).registerNativeSignatureFixture();
      },
      {
        module,
        fileUri,
        snapshot: {
          uri: Uri.file(join(root, "unrelated.txt")).toJSON(),
          text: "",
          languageId: "plaintext",
          version: 1,
          eol: 1,
          isDirty: false,
        },
      },
    );
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], { storageRoot: join(root, "storage") });
    await host.activateByEvent(session, "onStartupFinished");
    await registration.promise;
    const query = (name: string) => host.executeCommand(session, "fixture.signature", name);
    expect(await query("extension")).toEqual({
      typed: true,
      label: "call(a, b)",
      documentation: {
        typed: true,
        value: "**call**",
        trusted: { enabledCommands: ["fixture.signature"] },
        icons: true,
        uri: Uri.parse("signature-fixture://docs/guide?version=2#call").toString(),
      },
      activeSignature: 1,
      activeParameter: 0,
      signatureParameter: 1,
      parameters: [{ label: [8, 9], documentation: "second parameter" }],
    });
    const native = {
      typed: true,
      label: "native(value)",
      activeSignature: 0,
      activeParameter: 0,
      parameters: [{ label: "value" }],
    };
    expect(await query("native")).toEqual(native);
    expect(await query("file")).toEqual(native);
    expect(await query("missing")).toBeNull();
    const liveModels = await page.evaluate(
      async ({ module, resources }) => {
        const { hasResourceQueryModel } = await import(module);
        return resources.some(hasResourceQueryModel);
      },
      {
        module,
        resources: [
          fileUri,
          ...["extension", "native", "missing"].map((name) =>
            Uri.parse(`signature-fixture://workspace/${name}.sig?view=2#anchor`).toJSON(),
          ),
        ],
      },
    );
    expect(liveModels).toBe(false);
  } finally {
    await fixture.dispose(session);
    unlisten();
    await page.evaluate(
      async (module) => (await import(module)).closeProviderCommandModel(),
      module,
    );
    await rm(root, { recursive: true, force: true });
  }
});
