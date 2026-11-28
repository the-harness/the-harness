import { Uri } from "@harness/vscode-types";
import * as monaco from "monaco-editor";

const fileUris = new WeakMap<monaco.editor.ITextModel, () => Uri>();

export function associateFileModel(
  model: monaco.editor.ITextModel,
  resource: () => Uri,
): () => void {
  fileUris.set(model, resource);
  return () => {
    if (fileUris.get(model) === resource) fileUris.delete(model);
  };
}

export function documentUriForModel(resource: monaco.Uri): Uri {
  const model = monaco.editor.getModel(resource);
  return (model && fileUris.get(model)?.()) || Uri.from(resource);
}
