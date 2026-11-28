import type { VscodeLanguagesCompatService } from "@harness/vscode-editor-compat";
import {
  MarkdownString,
  ParameterInformation,
  Position,
  SignatureHelp,
  SignatureInformation,
  Uri,
  type TextDocumentData,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

type QueryResult = NonNullable<
  Awaited<ReturnType<VscodeLanguagesCompatService["executeSignatureHelpProvider"]>>
>;

function reviveDocumentation(value: QueryResult["signatures"][number]["documentation"]) {
  if (value === undefined || typeof value === "string") return value;
  const base = value.baseUri;
  return Object.assign(new MarkdownString(value.value, value.supportThemeIcons), {
    isTrusted: value.isTrusted,
    supportHtml: value.supportHtml ?? false,
    baseUri:
      typeof base === "string"
        ? Uri.parse(base)
        : base && Uri.from({ ...base, scheme: base.scheme ?? "file" }),
  });
}

export function registerSignatureHelpCommand(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
): void {
  bridge.commandHandlers.set(
    "vscode.executeSignatureHelpProvider",
    async (uri, position, trigger) => {
      if (!Uri.isUri(uri) || !Position.isPosition(position))
        throw new TypeError("Expected a document URI and position");
      if (trigger != null && typeof trigger !== "string")
        throw new TypeError("Expected a trigger character");
      const document = await openTextDocument(uri);
      const result = (await bridge.callMain(
        "languages.executeSignatureHelpProvider",
        uri.toJSON(),
        position,
        trigger ?? undefined,
        document.toJSON(),
      )) as QueryResult | undefined;
      if (!result) return undefined;
      const help = new SignatureHelp();
      help.activeSignature = result.activeSignature;
      help.activeParameter = result.activeParameter;
      help.signatures = result.signatures.map(
        ({ label, documentation, parameters, activeParameter }) => {
          const signature = new SignatureInformation(label, reviveDocumentation(documentation));
          signature.activeParameter = activeParameter;
          signature.parameters = (parameters ?? []).map(
            ({ label, documentation }) =>
              new ParameterInformation(label, reviveDocumentation(documentation)),
          );
          return signature;
        },
      );
      return help;
    },
  );
}
