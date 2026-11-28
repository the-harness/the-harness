import type { VscodeLanguagesCompatService } from "@harness/vscode-editor-compat";
import { DocumentLink, Range, Uri, type TextDocumentData } from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

type Links = Awaited<ReturnType<VscodeLanguagesCompatService["executeLinkProvider"]>>;

export function registerLinkCommand(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
): void {
  bridge.commandHandlers.set("vscode.executeLinkProvider", async (uri, linkResolveCount) => {
    if (!Uri.isUri(uri) || (linkResolveCount != null && typeof linkResolveCount !== "number"))
      throw new TypeError("Expected a document URI and optional link resolve count");
    const document = await openTextDocument(uri);
    const links = (await bridge.callMain(
      "languages.executeLinkProvider",
      uri.toJSON(),
      Math.min(linkResolveCount || 0, Number.MAX_SAFE_INTEGER),
      uri.scheme === "file" ? undefined : document.toJSON(),
    )) as Links;
    return links.map(({ range, target, tooltip }) => {
      const link = new DocumentLink(Range.of(range), target ? Uri.from(target) : undefined);
      link.tooltip = tooltip;
      return link;
    });
  });
}
