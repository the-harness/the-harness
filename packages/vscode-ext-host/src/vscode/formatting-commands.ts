import type { FormattingQuery } from "@harness/vscode-editor-compat";
import { Position, Range, TextEdit, Uri, type TextDocumentData } from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

export function registerFormattingCommands(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
): void {
  async function execute(resource: unknown, query: FormattingQuery) {
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
    const edits = (await bridge.callMain(
      "languages.executeFormattingProvider",
      uri.toJSON(),
      query,
      document.toJSON(),
    )) as TextEdit[] | undefined;
    return edits?.map(({ range, newText, newEol }) =>
      Object.assign(new TextEdit(Range.of(range), newText), { newEol }),
    );
  }

  bridge.commandHandlers.set("vscode.executeFormatDocumentProvider", (resource, options) =>
    execute(resource, { kind: "document", options }),
  );
  bridge.commandHandlers.set("vscode.executeFormatRangeProvider", (resource, range, options) => {
    if (!Range.isRange(range)) throw new TypeError("Expected a formatting range");
    return execute(resource, { kind: "range", range, options });
  });
  bridge.commandHandlers.set(
    "vscode.executeFormatOnTypeProvider",
    (resource, position, character, options) => {
      if (!Position.isPosition(position) || typeof character !== "string") {
        throw new TypeError("Expected a position and trigger character");
      }
      return execute(resource, { kind: "onType", position, character, options });
    },
  );
}
