import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id, language) => {
    if (language === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(language)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(language)) return new HtmlWorker();
    if (["typescript", "javascript"].includes(language)) return new TsWorker();
    return new EditorWorker();
  },
};
import {
  createExtensionContributions,
  type ExtensionContributionSnapshot,
} from "@harness/vscode-editor-compat/contributions";
import {
  getContributedFileIconClass,
  getContributedLanguageId,
  getContributedThemeName,
} from "@harness/vscode-editor-compat/contribution-state";
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { IStandaloneThemeService } from "monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js";
import { ICommandService } from "monaco-editor/esm/vs/platform/commands/common/commands.js";
import { ILanguageFeaturesService } from "monaco-editor/esm/vs/editor/common/services/languageFeatures.js";

export async function consumeBuiltinContributions(
  snapshots: ExtensionContributionSnapshot[],
  plans: { id: string; directory: string; minimumSmokeTests: { id: string; fixture: any }[] }[],
) {
  const adapter = await createExtensionContributions(snapshots);
  const container = document.createElement("div");
  container.style.cssText = "width:700px;height:200px";
  document.body.appendChild(container);
  const editor = monaco.editor.create(container, {
    language: "plaintext",
    value: "",
    automaticLayout: false,
    minimap: { enabled: false },
    occurrencesHighlight: "off",
    selectionHighlight: false,
  });
  const models: monaco.editor.ITextModel[] = [];
  const results: any[] = [];
  const setModel = (text: string, language: string, path: string) => {
    const model = monaco.editor.createModel(
      text,
      language,
      monaco.Uri.parse(`file:///contribution-audit/${path}`),
    );
    models.push(model);
    editor.setModel(model);
    return model;
  };
  try {
    for (const plan of plans) {
      const snapshot = snapshots.find((item) => item.id === plan.id)!;
      const result: any = {
        id: plan.id,
        directory: plan.directory,
        language: [],
        snippets: [],
        themes: [],
        icons: [],
        semanticScopes: [],
        unsupported: [],
        errors: adapter.issues.filter((issue) => issue.extensionId === plan.id),
      };
      try {
        const languageSmoke = plan.minimumSmokeTests.find((smoke) =>
          smoke.id.endsWith("/language-and-grammar"),
        );
        if (languageSmoke) {
          const fixture = languageSmoke.fixture;
          const language = fixture.languageId;
          const path = fixture.path;
          const model = setModel(fixture.text, language, `${plan.directory}/${path}`);
          const tokens = monaco.editor.tokenize(model.getValue(), language).flat();
          const scopes = [...new Set(tokens.map((token) => token.type))];
          const languageContributions = snapshot.contributes.languages as any[];
          const languageDefinition = languageContributions.find((item) => item.id === language);
          let comment:
            | { before: string; after: string; expected: string; expectedEnd?: string }
            | undefined;
          if (languageDefinition?.configuration) {
            const config = JSON.parse(
              snapshot.resources[languageDefinition.configuration.replace(/^\.\//, "")]!.contents,
            );
            const lineComment =
              typeof config.comments?.lineComment === "string"
                ? config.comments.lineComment
                : config.comments?.lineComment?.comment;
            if (lineComment) {
              model.setValue(language === "php" ? "<?php\nsample" : "sample");
              editor.setPosition({ lineNumber: language === "php" ? 2 : 1, column: 1 });
              await editor.getAction("editor.action.commentLine")!.run();
              comment = { before: "sample", after: model.getValue(), expected: lineComment };
            } else if (config.comments?.blockComment) {
              model.setValue("sample");
              editor.setSelection(new monaco.Range(1, 1, 1, 7));
              await editor.getAction("editor.action.blockComment")!.run();
              comment = {
                before: "sample",
                after: model.getValue(),
                expected: config.comments.blockComment[0],
                expectedEnd: config.comments.blockComment[1],
              };
            }
          }
          result.language.push({
            requested: language,
            detected: getContributedLanguageId(path, fixture.text.split("\n")[0]),
            modelLanguage: model.getLanguageId(),
            configurationResource: languageDefinition?.configuration,
            scopes,
            installedGrammar: adapter.registeredGrammars.get(language),
            comment,
          });
        }
        const snippets = adapter.snippets.filter(
          (snippet) => snippet.extensionId === plan.id && !snippet.isFileTemplate,
        );
        for (const language of new Set(snippets.map((snippet) => snippet.language))) {
          const snippet = snippets.find((item) => item.language === language)!;
          const model = setModel(
            snippet.prefixes[0]!,
            language,
            `snippet-${plan.directory}-${language}.txt`,
          );
          editor.setPosition({ lineNumber: 1, column: model.getLineMaxColumn(1) });
          const providers =
            StandaloneServices.get(ILanguageFeaturesService).completionProvider.ordered(model);
          const provider = providers.find(
            (item) => item._debugDisplayName === "VS Code contributed snippets",
          )!;
          if (!provider) throw new Error(`No registered snippet provider for ${language}`);
          const completions = await provider.provideCompletionItems(
            model,
            editor.getPosition()!,
            { triggerKind: 0 },
            { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
          );
          const completion = completions!.suggestions.find(
            (item) => item.label === snippet.prefixes[0] && item.detail === snippet.name,
          )!;
          editor.setSelection(completion.range as monaco.Range);
          const previousVersion = model.getVersionId();
          editor
            .getContribution<{ insert(template: string): void; dispose(): void }>(
              "snippetController2",
            )!
            .insert(completion.insertText as string);
          result.snippets.push({
            language,
            name: snippet.name,
            prefix: snippet.prefixes[0],
            body: snippet.body,
            inserted: model.getValue(),
            selection: editor.getSelection(),
            provider: !!provider,
            versionChanged: model.getVersionId() > previousVersion,
          });
        }
        for (const snippet of adapter.snippets.filter(
          (snippet) => snippet.extensionId === plan.id && snippet.isFileTemplate,
        )) {
          const model = setModel(
            "replace this file",
            snippet.language,
            `template-${plan.directory}-${snippet.language}.txt`,
          );
          editor.focus();
          await StandaloneServices.get(ICommandService).executeCommand(snippet.actionId!);
          result.snippets.push({
            language: snippet.language,
            name: snippet.name,
            prefix: null,
            body: snippet.body,
            inserted: model.getValue(),
            selection: editor.getSelection(),
            selectedText: model.getValueInRange(editor.getSelection()!),
            provider: true,
            template: true,
            versionChanged: true,
          });
        }
        for (const theme of adapter.availableThemes.filter(
          (item) => item.extensionId === plan.id,
        )) {
          adapter.setTheme(theme.id);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const expectedBackground = document.createElement("span");
          expectedBackground.style.color =
            document.documentElement.style.getPropertyValue("--vscode-editor-background") ||
            (theme.uiTheme === "vs" || theme.uiTheme === "hc-light"
              ? "#ffffff"
              : theme.uiTheme === "hc-black"
                ? "#000000"
                : "#1e1e1e");
          container.appendChild(expectedBackground);
          const normalizedExpectedBackground = getComputedStyle(expectedBackground).color;
          expectedBackground.remove();
          result.themes.push({
            expectedBackground: normalizedExpectedBackground,
            id: theme.id,
            selected: getContributedThemeName(),
            editorBackground: getComputedStyle(
              container.querySelector(".monaco-editor-background")!,
            ).backgroundColor,
            cssBackground: document.documentElement.style.getPropertyValue(
              "--vscode-editor-background",
            ),
            colorMap: !!document.querySelector(".monaco-colors")?.textContent,
          });
        }
        for (const theme of adapter.availableIconThemes.filter(
          (item) => item.extensionId === plan.id,
        )) {
          adapter.setIconTheme(theme.id);
          const icon = document.createElement("span");
          icon.className = getContributedFileIconClass("example.ts")!;
          icon.style.cssText = "display:block;width:24px;height:24px";
          container.appendChild(icon);
          await document.fonts.ready;
          const style = getComputedStyle(icon),
            before = getComputedStyle(icon, "::before");
          if (before.fontFamily) await document.fonts.load(`16px ${before.fontFamily}`);
          let imageDecoded = false;
          if (style.backgroundImage !== "none") {
            const image = new Image();
            image.src = JSON.parse(style.backgroundImage.slice(4, -1));
            await image.decode();
            imageDecoded = image.naturalWidth > 0 && image.naturalHeight > 0;
          }
          result.icons.push({
            imageDecoded,
            id: theme.id,
            className: icon.className,
            image: style.backgroundImage,
            font: before.fontFamily,
            content: before.content,
            fontLoaded: document.fonts.check(`16px ${before.fontFamily}`),
          });
          icon.remove();
        }
        for (const contribution of (snapshot.contributes.semanticTokenScopes ?? []) as {
          language: string;
          scopes: Record<string, string[]>;
        }[]) {
          adapter.setTheme("Dark+");
          const text = "const object = { property: 1 }; object.property;";
          const model = setModel(
            text,
            contribution.language,
            `semantic-${contribution.language}.txt`,
          );
          const tokenization = (model as any).tokenization;
          tokenization.forceTokenization(1);
          const tokens = tokenization.getLineTokens(1);
          const theme = StandaloneServices.get(IStandaloneThemeService).getColorTheme();
          const colors = theme.tokenTheme.getColorMap();
          const tokenIndex = tokens.findTokenIndexAtOffset(text.lastIndexOf("property"));
          const semantic = theme.getTokenStyleMetadata("property", [], contribution.language)!;
          result.semanticScopes.push({
            language: contribution.language,
            selector: "property",
            declaredScopes: contribution.scopes.property,
            textMateForeground: colors[tokens.getForeground(tokenIndex)]?.toString(),
            semanticForeground: colors[semantic.foreground!]?.toString(),
            consumer:
              "Monaco StandaloneTheme.getTokenStyleMetadata ignores modelLanguage and only matches semantic type/modifiers; semanticTokenScopes is not registered",
          });
        }
        const unhandled = Object.keys(snapshot.contributes).filter(
          (kind) => !["languages", "grammars", "snippets", "themes", "iconThemes"].includes(kind),
        );
        result.unsupported.push(
          ...unhandled.map((kind) => ({
            kind,
            entries: snapshot.contributes[kind],
            reason: "No production consumer in the contribution adapter for this contribution kind",
          })),
        );
      } catch (error) {
        result.errors.push({ kind: "consumer", message: String(error) });
      }
      results.push(result);
    }
    const associations = [
      ["/fixture/Dockerfile.dev", "", "dockerfile"],
      ["/fixture/.env.local", "", "dotenv"],
      ["/fixture/compose.prod.yaml", "", "dockercompose"],
      ["/fixture/.github/agents/demo.md", "", "chatagent"],
      ["/fixture/.claude/rules/demo.md", "", "instructions"],
      ["/fixture/.git/config", "", "properties"],
      ["/fixture/script", "#!/usr/bin/env python", "python"],
    ].map(([path, firstLine, expected]) => ({
      path,
      expected,
      actual: getContributedLanguageId(path!, firstLine),
    }));
    return {
      results,
      associations,
      issues: adapter.issues,
      registeredLanguages: adapter.registeredLanguages.size,
      registeredGrammars: adapter.registeredGrammars.size,
    };
  } finally {
    editor.dispose();
    models.forEach((model) => model.dispose());
    container.remove();
    adapter.dispose();
  }
}
