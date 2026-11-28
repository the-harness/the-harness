declare module "monaco-editor/esm/vs/editor/common/services/languageFeatures.js";

declare module "monaco-editor/esm/vs/editor/contrib/links/browser/getLinks.js" {
  import type * as monaco from "monaco-editor";

  export function getLinks(
    providers: { ordered(model: monaco.editor.ITextModel): monaco.languages.LinkProvider[] },
    model: monaco.editor.ITextModel,
    token: monaco.CancellationToken,
  ): Promise<{
    links: (monaco.languages.ILink & {
      resolve(token: monaco.CancellationToken): Promise<monaco.Uri | string>;
    })[];
    dispose(): void;
  }>;
}
