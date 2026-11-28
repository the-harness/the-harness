import { Position, Range, SelectionRange, Uri, type TextDocumentData } from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

export function registerSelectionRangeCommand(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
): void {
  bridge.commandHandlers.set(
    "vscode.executeSelectionRangeProvider",
    async (resource, positions) => {
      if (
        !resource ||
        typeof resource !== "object" ||
        !("scheme" in resource) ||
        typeof resource.scheme !== "string" ||
        !Array.isArray(positions) ||
        !positions.every(Position.isPosition)
      ) {
        throw new TypeError("Expected a document URI and an array of positions");
      }
      const uri =
        resource instanceof Uri ? resource : Uri.from({ ...resource, scheme: resource.scheme });
      const document = await openTextDocument(uri);
      const ranges = (await bridge.callMain(
        "languages.executeSelectionRangeProvider",
        uri.toJSON(),
        positions,
        uri.scheme === "file" ? undefined : document.toJSON(),
      )) as Range[][];
      return ranges.map((chain) =>
        chain.reduceRight<SelectionRange | undefined>(
          (parent, range) => new SelectionRange(Range.of(range), parent),
          undefined,
        ),
      );
    },
  );
}
