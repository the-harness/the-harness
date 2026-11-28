import * as monaco from "monaco-editor";

const owner = "fixture-editor-native";

export function publishNativeDiagnostic(path: string, createModel = false): void {
  const uri = monaco.Uri.file(path);
  const model = createModel
    ? monaco.editor.createModel("fixture content", "plaintext", uri)
    : monaco.editor.getModel(uri);
  if (!model) throw new Error(`Model not found: ${path}`);
  monaco.editor.setModelMarkers(model, owner, [
    {
      message: "Editor lint",
      source: "monaco-fixture",
      severity: monaco.MarkerSeverity.Warning,
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 6,
      code: { value: "E001", target: monaco.Uri.parse("https://example.org/docs#E001") },
      tags: [monaco.MarkerTag.Unnecessary],
      relatedInformation: [
        {
          resource: uri,
          message: "Original value",
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
        },
      ],
    },
  ]);
}

export function clearNativeDiagnostic(path: string): void {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (!model) throw new Error(`Model not found: ${path}`);
  monaco.editor.setModelMarkers(model, owner, []);
}

export function markerMessages(path: string): string[] {
  return monaco.editor
    .getModelMarkers({ resource: monaco.Uri.file(path) })
    .map(({ message }) => message)
    .sort();
}
