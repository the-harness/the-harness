import type { VscodeLanguagesCompatService } from "@harness/vscode-editor-compat";
import {
  Location,
  Range,
  SymbolInformation,
  Uri,
  type DocumentSymbol,
  type TextDocumentData,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

type QuerySymbol = Awaited<
  ReturnType<VscodeLanguagesCompatService["executeDocumentSymbolProvider"]>
>[number];

function reviveSymbol(uri: Uri, symbol: QuerySymbol): SymbolInformation & DocumentSymbol {
  const range = Range.of(symbol.range);
  return Object.assign(
    new SymbolInformation(
      symbol.name,
      symbol.kind,
      symbol.containerName ?? "",
      new Location(uri, range),
    ),
    {
      detail: symbol.detail,
      range,
      selectionRange: Range.of(symbol.selectionRange),
      children: symbol.children.map((child) => reviveSymbol(uri, child)),
    },
  );
}

export function registerDocumentSymbolCommand(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
): void {
  bridge.commandHandlers.set("vscode.executeDocumentSymbolProvider", async (uri) => {
    if (!(uri instanceof Uri)) throw new TypeError("Expected a document URI");
    const document = await openTextDocument(uri);
    const symbols = (await bridge.callMain(
      "languages.executeDocumentSymbolProvider",
      uri.toJSON(),
      uri.scheme === "file" ? undefined : document.toJSON(),
    )) as QuerySymbol[];
    if (symbols.length) return symbols.map((symbol) => reviveSymbol(uri, symbol));
    return undefined;
  });
}
