import { ref } from "vue";
import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "typescript",
  jsx: "typescript",
  javascript: "typescript",
  vue: "vue",
  html: "vue",
  json: "json",
  jsonc: "json",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  css: "css",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
};

const LAZY_GRAMMARS: Record<string, () => Promise<{ default: any }>> = {
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

export function resolveGrammarLang(lang = ""): string | undefined {
  const normalized = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LANG_ALIASES[normalized];
}

export class MarkdownHighlighterService {
  readonly ready = ref(false);
  readonly grammarVersion = ref(0);
  #highlighter: HighlighterCore | undefined;
  #loading: Promise<void> | undefined;
  readonly #pendingGrammars = new Set<string>();

  get highlighter(): HighlighterCore | undefined {
    return this.#highlighter;
  }

  load(): Promise<void> {
    this.#loading ??= Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-dark.mjs"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/vue.mjs"),
      import("shiki/langs/json.mjs"),
    ])
      .then(
        async ([
          { createHighlighterCore },
          { createJavaScriptRegexEngine },
          dark,
          light,
          typescript,
          vue,
          json,
        ]) => {
          this.#highlighter = await createHighlighterCore({
            themes: [dark.default, light.default],
            langs: [typescript.default, vue.default, json.default],
            engine: createJavaScriptRegexEngine({ forgiving: true }),
          });
          this.ready.value = true;
        },
      )
      .catch(() => {
        this.#loading = undefined;
      });
    return this.#loading;
  }

  ensureGrammarLoaded(resolved: string): boolean {
    const highlighter = this.#highlighter;
    if (!highlighter) return false;
    if (highlighter.getLoadedLanguages().includes(resolved)) return true;
    const loader = LAZY_GRAMMARS[resolved];
    if (loader && !this.#pendingGrammars.has(resolved)) {
      this.#pendingGrammars.add(resolved);
      void loader()
        .then(async (mod) => {
          await highlighter.loadLanguage(mod.default);
          this.grammarVersion.value += 1;
        })
        .catch(() => {
          this.#pendingGrammars.delete(resolved);
        });
    }
    return false;
  }
}

export interface HighlightSpan {
  readonly text: string;
  readonly color?: string;
  readonly fontStyle?: number;
}

const TOKENIZE_MAX_LINE_LENGTH = 1000;

function toLineSpans(line: ThemedToken[]): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  let pendingWhitespace = "";
  for (let i = 0; i < line.length; i++) {
    const token = line[i]!;
    if (/^\s+$/.test(token.content) && i + 1 < line.length) {
      pendingWhitespace += token.content;
      continue;
    }
    spans.push({
      text: pendingWhitespace + token.content,
      color: token.color,
      fontStyle: token.fontStyle,
    });
    pendingWhitespace = "";
  }
  return spans;
}

export class StreamingHighlightSession {
  private readonly service: MarkdownHighlighterService;

  constructor(service: MarkdownHighlighterService) {
    this.service = service;
  }

  private resolvedLang: string | undefined;
  private activeTheme: string | undefined;
  private prefix = "";
  private stableLines: HighlightSpan[][] = [];
  private grammarState: GrammarState | undefined;
  private lastCode: string | undefined;
  private lastResult: readonly HighlightSpan[][] | undefined;

  private reset(resolvedLang: string | undefined, activeTheme: string) {
    this.resolvedLang = resolvedLang;
    this.activeTheme = activeTheme;
    this.prefix = "";
    this.stableLines = [];
    this.grammarState = undefined;
    this.lastCode = undefined;
    this.lastResult = undefined;
  }

  update(
    code: string,
    lang: string | undefined,
    currentTheme: "dark" | "light",
  ): readonly HighlightSpan[][] | undefined {
    const highlighterInstance = this.service.highlighter;
    if (!highlighterInstance) return undefined;
    const resolved = resolveGrammarLang(lang);
    if (!resolved || !this.service.ensureGrammarLoaded(resolved)) {
      return undefined;
    }
    const themeName = currentTheme === "light" ? "github-light" : "github-dark";
    if (
      code === this.lastCode &&
      resolved === this.resolvedLang &&
      themeName === this.activeTheme &&
      this.lastResult !== undefined
    ) {
      return this.lastResult;
    }
    if (
      resolved !== this.resolvedLang ||
      themeName !== this.activeTheme ||
      !code.startsWith(this.prefix)
    ) {
      this.reset(resolved, themeName);
    }

    const rest = code.slice(this.prefix.length);
    const lastNewline = rest.lastIndexOf("\n");
    if (lastNewline >= 0) {
      const completedChunk =
        rest[lastNewline - 1] === "\r"
          ? rest.slice(0, lastNewline - 1)
          : rest.slice(0, lastNewline);
      const tokens = highlighterInstance.codeToTokensBase(completedChunk, {
        lang: resolved,
        theme: themeName,
        tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
        ...(this.grammarState ? { grammarState: this.grammarState } : {}),
      });
      for (const line of tokens) {
        this.stableLines.push(toLineSpans(line));
      }
      this.grammarState = highlighterInstance.getLastGrammarState(tokens);
      this.prefix = code.slice(0, this.prefix.length + lastNewline + 1);
    }

    const tailText = code.slice(this.prefix.length);
    const tailTokens =
      tailText.length > 0 || this.stableLines.length === 0
        ? highlighterInstance
            .codeToTokensBase(tailText, {
              lang: resolved,
              theme: themeName,
              tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
              ...(this.grammarState ? { grammarState: this.grammarState } : {}),
            })
            .map(toLineSpans)
        : [];

    this.lastCode = code;
    this.lastResult = [...this.stableLines, ...tailTokens];
    return this.lastResult;
  }
}
