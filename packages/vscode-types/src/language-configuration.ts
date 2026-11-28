import type { IndentAction, SyntaxTokenType } from "./enums.ts";

type LanguageConfigurationWithPatterns<Pattern> = {
  comments?: {
    lineComment?: string | { comment: string; noIndent?: boolean };
    blockComment?: [string, string];
  };
  brackets?: [string, string][];
  wordPattern?: Pattern;
  indentationRules?: {
    decreaseIndentPattern: Pattern;
    increaseIndentPattern: Pattern;
    indentNextLinePattern?: Pattern;
    unIndentedLinePattern?: Pattern;
  };
  onEnterRules?: {
    beforeText: Pattern;
    afterText?: Pattern;
    previousLineText?: Pattern;
    action: { indentAction: IndentAction; appendText?: string; removeText?: number };
  }[];
  autoClosingPairs?: { open: string; close: string; notIn?: SyntaxTokenType[] }[];
  __characterPairSupport?: {
    autoClosingPairs: { open: string; close: string; notIn?: string[] }[];
  };
  __electricCharacterSupport?: {
    brackets?: unknown;
    docComment?: { scope: string; open: string; lineStart: string; close?: string };
  };
};

export type LanguageConfiguration = LanguageConfigurationWithPatterns<RegExp>;

export type LanguageConfigurationSnapshot = LanguageConfigurationWithPatterns<{
  source: string;
  flags: string;
}>;
