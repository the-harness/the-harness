import type { VscodeLanguagesCompatService } from "@harness/vscode-editor-compat";
import {
  Hover,
  MarkdownString,
  Position,
  Range,
  Uri,
  type TextDocumentData,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

type HoverQueryResults = Awaited<ReturnType<VscodeLanguagesCompatService["executeHoverProvider"]>>;

export function registerHoverCommand(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
): void {
  bridge.commandHandlers.set("vscode.executeHoverProvider", async (uri, position) => {
    if (!Uri.isUri(uri) || !Position.isPosition(position))
      throw new TypeError("Expected a document URI and position");
    const document = await openTextDocument(uri);
    const hovers = (await bridge.callMain(
      "languages.executeHoverProvider",
      uri.toJSON(),
      { line: position.line, character: position.character },
      document.toJSON(),
    )) as HoverQueryResults;
    return hovers.map(
      ({ contents, range }) =>
        new Hover(
          contents.map(({ value, isTrusted, supportHtml, supportThemeIcons, baseUri }) =>
            Object.assign(new MarkdownString(value, supportThemeIcons), {
              isTrusted,
              supportHtml: supportHtml ?? false,
              baseUri: baseUri ? Uri.from(baseUri) : undefined,
            }),
          ),
          range ? Range.of(range) : undefined,
        ),
    );
  });
}
