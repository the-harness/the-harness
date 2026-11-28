import type {
  SemanticTokensQuery,
  VscodeLanguagesCompatService,
} from "@harness/vscode-editor-compat";
import {
  Range,
  SemanticTokens,
  SemanticTokensLegend,
  Uri,
  type TextDocumentData,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

export function registerSemanticTokenCommands(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
): void {
  async function execute(resource: unknown, query: SemanticTokensQuery) {
    if (
      !resource ||
      typeof resource !== "object" ||
      !("scheme" in resource) ||
      typeof resource.scheme !== "string"
    ) {
      throw new TypeError("Expected a document URI");
    }
    const uri =
      resource instanceof Uri ? resource : Uri.from({ ...resource, scheme: resource.scheme });
    const document = await openTextDocument(uri);
    const result = (await bridge.callMain(
      "languages.provideSemanticTokens",
      uri.toJSON(),
      query,
      document.toJSON(),
    )) as Awaited<ReturnType<VscodeLanguagesCompatService["provideSemanticTokens"]>>;
    if (!result) return undefined;
    return Array.isArray(result)
      ? new SemanticTokens(Uint32Array.from(result))
      : new SemanticTokensLegend(result.tokenTypes, result.tokenModifiers);
  }

  for (const command of [
    "provideDocumentSemanticTokens",
    "provideDocumentSemanticTokensLegend",
  ] as const) {
    bridge.commandHandlers.set(`vscode.${command}`, (resource) => execute(resource, { command }));
  }
  bridge.commandHandlers.set("vscode.provideDocumentRangeSemanticTokens", (resource, range) => {
    if (!Range.isRange(range)) throw new TypeError("Expected a semantic tokens range");
    return execute(resource, { command: "provideDocumentRangeSemanticTokens", range });
  });
  bridge.commandHandlers.set(
    "vscode.provideDocumentRangeSemanticTokensLegend",
    (resource, range) => {
      if (range != null && !Range.isRange(range))
        throw new TypeError("Expected a semantic tokens range");
      return execute(resource, {
        command: "provideDocumentRangeSemanticTokensLegend",
        range: range ?? undefined,
      });
    },
  );
}
