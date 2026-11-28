import type { LanguageConfigurationSnapshot } from "@harness/vscode-types";
import type * as monaco from "monaco-editor";
import { ILanguageConfigurationService } from "monaco-editor/esm/vs/editor/common/languages/languageConfigurationRegistry.js";
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";

type Pattern = NonNullable<LanguageConfigurationSnapshot["wordPattern"]>;
const tokenNames = ["other", "comment", "string", "regex"] as const;

function pattern({ source, flags }: Pattern): RegExp {
  return new RegExp(source, flags);
}

function toLanguageConfiguration(
  configuration: LanguageConfigurationSnapshot,
): monaco.languages.LanguageConfiguration {
  const { comments, indentationRules, wordPattern, onEnterRules, autoClosingPairs } = configuration;
  const lineComment = comments?.lineComment;
  const docComment = configuration.__electricCharacterSupport?.docComment;
  return {
    comments: comments && {
      lineComment: typeof lineComment === "string" ? lineComment : lineComment?.comment,
      blockComment: comments.blockComment,
    },
    brackets: configuration.brackets,
    wordPattern: wordPattern && pattern(wordPattern),
    indentationRules: indentationRules && {
      decreaseIndentPattern: pattern(indentationRules.decreaseIndentPattern),
      increaseIndentPattern: pattern(indentationRules.increaseIndentPattern),
      indentNextLinePattern:
        indentationRules.indentNextLinePattern && pattern(indentationRules.indentNextLinePattern),
      unIndentedLinePattern:
        indentationRules.unIndentedLinePattern && pattern(indentationRules.unIndentedLinePattern),
    },
    onEnterRules: onEnterRules?.map(({ beforeText, afterText, previousLineText, action }) => ({
      beforeText: pattern(beforeText),
      afterText: afterText && pattern(afterText),
      previousLineText: previousLineText && pattern(previousLineText),
      action,
    })),
    autoClosingPairs:
      autoClosingPairs?.map(({ open, close, notIn }) => ({
        open,
        close,
        notIn: notIn?.map((token) => tokenNames[token]),
      })) ?? configuration.__characterPairSupport?.autoClosingPairs,
    __electricCharacterSupport: docComment && {
      docComment: { open: docComment.open, close: docComment.close },
    },
  };
}

export function registerRuntimeLanguageConfiguration(
  language: string,
  configuration: LanguageConfigurationSnapshot,
): { dispose(): void } {
  const service = StandaloneServices.get(ILanguageConfigurationService) as {
    register(
      language: string,
      configuration: monaco.languages.LanguageConfiguration,
      priority: number,
    ): { dispose(): void };
  };
  // Monaco's standalone contributions register at priority 100.
  return service.register(language, toLanguageConfiguration(configuration), 101);
}
