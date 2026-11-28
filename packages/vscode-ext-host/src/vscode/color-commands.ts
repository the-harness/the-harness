import {
  Color,
  ColorInformation,
  ColorPresentation,
  Range,
  TextEdit,
  Uri,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

export function reviveColor({ red, green, blue, alpha }: Color): Color {
  return new Color(red, green, blue, alpha);
}

function reviveTextEdit(edit: TextEdit): TextEdit {
  const result = new TextEdit(Range.of(edit.range), edit.newText);
  result.newEol = edit.newEol;
  return result;
}

export function registerColorCommands(bridge: ExtHostBridge): void {
  bridge.commandHandlers.set("vscode.executeDocumentColorProvider", async (uri) => {
    if (!(uri instanceof Uri)) throw new TypeError("Expected a document URI");
    const colors = (await bridge.callMain(
      "languages.executeDocumentColorProvider",
      uri.toJSON(),
    )) as ColorInformation[];
    return colors.map(
      ({ range, color }) => new ColorInformation(Range.of(range), reviveColor(color)),
    );
  });

  bridge.commandHandlers.set("vscode.executeColorPresentationProvider", async (color, context) => {
    const { uri, range } = (context ?? {}) as { uri?: unknown; range?: unknown };
    if (!(color instanceof Color) || !(uri instanceof Uri) || !Range.isRange(range))
      throw new TypeError("Expected a Color and a context with a URI and range");
    const presentations = (await bridge.callMain(
      "languages.executeColorPresentationProvider",
      color,
      { uri: uri.toJSON(), range },
    )) as ColorPresentation[];
    return presentations.map(({ label, textEdit, additionalTextEdits }) => {
      const presentation = new ColorPresentation(label);
      if (textEdit) presentation.textEdit = reviveTextEdit(textEdit);
      if (additionalTextEdits)
        presentation.additionalTextEdits = additionalTextEdits.map(reviveTextEdit);
      return presentation;
    });
  });
}
