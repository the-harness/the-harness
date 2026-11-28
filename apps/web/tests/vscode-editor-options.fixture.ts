import * as monaco from "monaco-editor";

export function editorOptions(file: string, update?: monaco.editor.ITextModelUpdateOptions) {
  const editor = monaco.editor.getEditors().find((item) => item.getModel()?.uri.fsPath === file);
  const model = editor?.getModel();
  if (!editor || !model) throw new Error(`Editor not mounted: ${file}`);
  if (update) model.updateOptions(update);
  const { tabSize, indentSize, insertSpaces } = model.getOptions();
  return {
    tabSize,
    indentSize,
    insertSpaces,
    cursorStyle: editor.getOption(monaco.editor.EditorOption.cursorStyle),
    lineNumbers: editor.getOption(monaco.editor.EditorOption.lineNumbers).renderType,
  };
}
