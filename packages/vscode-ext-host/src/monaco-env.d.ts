declare module "monaco-editor/esm/vs/editor/common/languageSelector.js" {
  import type { languages } from "monaco-editor";

  type SelectorUri = { readonly scheme: string; readonly fsPath: string };

  export function score(
    selector: languages.LanguageSelector,
    candidateUri: SelectorUri,
    candidateLanguage: string,
    candidateIsSynchronized: boolean,
    candidateNotebookUri?: SelectorUri,
    candidateNotebookType?: string,
  ): number;
}
