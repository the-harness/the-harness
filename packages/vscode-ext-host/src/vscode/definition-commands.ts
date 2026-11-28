import {
  Location,
  Position,
  Range,
  Uri,
  type LocationLink,
  type TextDocumentData,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

export function registerDefinitionCommands(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
): void {
  for (const [command, kind] of [
    ["vscode.executeDefinitionProvider", "definition"],
    ["vscode.executeTypeDefinitionProvider", "typeDefinition"],
  ] as const) {
    bridge.commandHandlers.set(command, async (uri, position) => {
      if (!Uri.isUri(uri) || !Position.isPosition(position))
        throw new TypeError("Expected a document URI and position");
      const document = await openTextDocument(uri);
      const locations = (await bridge.callMain(
        "languages.executeDefinitionProvider",
        kind,
        uri.toJSON(),
        position,
        uri.scheme === "file" ? undefined : document.toJSON(),
      )) as (Location | LocationLink)[];
      return locations.map((location) =>
        "targetUri" in location
          ? {
              targetUri: Uri.from(location.targetUri),
              targetRange: Range.of(location.targetRange),
              targetSelectionRange:
                location.targetSelectionRange && Range.of(location.targetSelectionRange),
              originSelectionRange:
                location.originSelectionRange && Range.of(location.originSelectionRange),
            }
          : new Location(Uri.from(location.uri), Range.of(location.range)),
      );
    });
  }
}
