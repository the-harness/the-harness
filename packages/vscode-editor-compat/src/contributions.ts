/// <reference path="./contributions-env.d.ts" />
import picomatch from "picomatch";
import { triggerRef, watch } from "vue";
import * as monaco from "monaco-editor";
import { parse, type ParseError } from "jsonc-parser";
import * as textmate from "vscode-textmate";
import * as oniguruma from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import { activeContributions, type ContributedColorTheme } from "./contribution-state.ts";
export {
  getContributedLanguageId,
  getContributedThemeName,
  getContributedFileIconClass,
} from "./contribution-state.ts";

export interface ExtensionContributionSnapshot {
  id: string;
  contributes: Record<string, unknown>;
  resources: Record<string, { contents: string; encoding: "utf8" | "base64"; mimeType: string }>;
  errors: { path: string; message: string }[];
}
interface LanguageContribution {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
  firstLine?: string;
  configuration?: string;
}
interface GrammarContribution {
  language?: string;
  scopeName: string;
  path: string;
  injectTo?: string[];
  embeddedLanguages?: Record<string, string>;
  tokenTypes?: Record<string, string>;
  balancedBracketScopes?: string[];
  unbalancedBracketScopes?: string[];
}
interface ThemeContribution {
  id?: string;
  label: string;
  path: string;
  uiTheme: ContributedColorTheme["uiTheme"];
}
interface IconThemeContribution {
  id: string;
  label: string;
  path: string;
}
export interface ContributedSnippet {
  extensionId: string;
  language: string;
  name: string;
  prefixes: string[];
  body: string;
  description?: string;
  isFileTemplate?: boolean;
  actionId?: string;
}
export interface ContributionIssue {
  extensionId: string;
  kind: string;
  message: string;
}

let wasmReady: Promise<void> | undefined;
let registrationCounter = 0;
const languageRegistrations = new Set<string>();
function normalizePath(path: string): string {
  const result: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return result.join("/");
}
function relativeResource(base: string, path: string): string {
  return normalizePath(`${base.split("/").slice(0, -1).join("/")}/${path}`);
}
function cssContent(value: string): string {
  const decoded = value.replace(/\\([0-9a-f]{1,6})(?:\s)?/gi, (_match, hex: string) => {
    const code = parseInt(hex, 16);
    return String.fromCodePoint(
      code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code,
    );
  });
  return `"${Array.from(decoded, (character) => `\\${character.codePointAt(0)!.toString(16)} `).join("")}"`;
}
function readResource(snapshot: ExtensionContributionSnapshot, path: string): string {
  const resource = snapshot.resources[normalizePath(path)];
  if (!resource || resource.encoding !== "utf8")
    throw new Error(`Missing text contribution resource: ${path}`);
  return resource.contents;
}
function readJson(snapshot: ExtensionContributionSnapshot, path: string): any {
  const errors: ParseError[] = [];
  const result = parse(readResource(snapshot, path), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Invalid JSONC contribution: ${path} (${errors[0]!.error})`);
  return result;
}
function regex(
  value: string | { pattern: string; flags?: string } | undefined,
): RegExp | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? new RegExp(value) : new RegExp(value.pattern, value.flags);
}
function languageConfiguration(raw: any): monaco.languages.LanguageConfiguration {
  const pairs = (values: any[] | undefined) =>
    values?.map((pair) => (Array.isArray(pair) ? { open: pair[0], close: pair[1] } : pair));
  const indentationRules =
    raw.indentationRules &&
    Object.fromEntries(
      Object.entries(raw.indentationRules).map(([key, value]) => [key, regex(value as string)]),
    );
  const indentActions: Record<string, number> = {
    none: 0,
    indent: 1,
    indentOutdent: 2,
    outdent: 3,
  };
  return {
    ...raw,
    wordPattern: regex(raw.wordPattern),
    comments: raw.comments && {
      ...raw.comments,
      lineComment:
        typeof raw.comments.lineComment === "object"
          ? raw.comments.lineComment.comment
          : raw.comments.lineComment,
    },
    autoClosingPairs: pairs(raw.autoClosingPairs),
    surroundingPairs: pairs(raw.surroundingPairs),
    indentationRules,
    folding: raw.folding && {
      ...raw.folding,
      markers: raw.folding.markers && {
        start: regex(raw.folding.markers.start),
        end: regex(raw.folding.markers.end),
      },
    },
    onEnterRules: raw.onEnterRules?.map((rule: any) => ({
      ...rule,
      beforeText: regex(rule.beforeText),
      afterText: regex(rule.afterText),
      previousLineText: regex(rule.previousLineText),
      action: { ...rule.action, indentAction: indentActions[rule.action.indent] ?? 0 },
    })),
  };
}
class TokenState implements monaco.languages.IState {
  readonly stack: textmate.StateStack;
  constructor(stack: textmate.StateStack) {
    this.stack = stack;
  }
  clone(): TokenState {
    return this;
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TokenState && this.stack.equals(other.stack);
  }
}

export class ExtensionContributions {
  readonly issues: ContributionIssue[] = [];
  readonly snippets: ContributedSnippet[] = [];
  readonly availableThemes: { id: string; label: string; uiTheme: string; extensionId: string }[] =
    [];
  readonly availableIconThemes: { id: string; label: string; extensionId: string }[] = [];
  readonly registeredLanguages = new Map<string, LanguageContribution>();
  readonly registeredGrammars = new Map<string, { extensionId: string; scopeName: string }>();
  private readonly subscriptions: { dispose(): void }[] = [];
  private readonly grammars = new Map<
    string,
    {
      snapshot: ExtensionContributionSnapshot;
      contribution: GrammarContribution;
      raw: textmate.IRawGrammar;
    }
  >();
  private readonly grammarEntries: {
    snapshot: ExtensionContributionSnapshot;
    contribution: GrammarContribution;
  }[] = [];
  private readonly themes = new Map<
    string,
    { snapshot: ExtensionContributionSnapshot; contribution: ThemeContribution }
  >();
  private readonly iconThemes = new Map<
    string,
    { snapshot: ExtensionContributionSnapshot; contribution: IconThemeContribution }
  >();
  private readonly cssValues = new Map<string, string>();
  private registry!: textmate.Registry;
  private iconStyle: HTMLStyleElement | undefined;
  private iconData: any;
  private iconClassPrefix = "";
  private appliedColorTheme: ContributedColorTheme | undefined;
  private themeKind: "dark" | "light";
  private readonly root: HTMLElement | undefined;
  private disposed = false;
  private readonly namePrefix = `vscode-contribution-${++registrationCounter}`;

  constructor(options: { themeKind?: "dark" | "light"; colorTarget?: HTMLElement } = {}) {
    this.themeKind = options.themeKind ?? "dark";
    this.root =
      options.colorTarget ??
      (typeof document !== "undefined" ? document.documentElement : undefined);
  }

  async load(
    snapshots: readonly ExtensionContributionSnapshot[],
    options: {
      theme?: string;
      iconTheme?: string;
      getMaxTokenizationLineLength?: (languageId: string) => number | undefined;
    } = {},
  ): Promise<void> {
    wasmReady ??= fetch(onigWasmUrl).then((response) => {
      if (!response.ok) throw new Error(`Cannot load Oniguruma WASM: ${response.status}`);
      return oniguruma.loadWASM(response);
    });
    await wasmReady;
    for (const snapshot of snapshots) {
      this.issues.push(
        ...snapshot.errors.map((error) => ({
          extensionId: snapshot.id,
          kind: "resource",
          message: `${error.path}: ${error.message}`,
        })),
      );
      for (const language of (snapshot.contributes.languages ?? []) as LanguageContribution[]) {
        const previous = this.registeredLanguages.get(language.id);
        this.registeredLanguages.set(language.id, {
          ...previous,
          ...language,
          extensions: [...(previous?.extensions ?? []), ...(language.extensions ?? [])],
          filenames: [...(previous?.filenames ?? []), ...(language.filenames ?? [])],
          filenamePatterns: [
            ...(previous?.filenamePatterns ?? []),
            ...(language.filenamePatterns ?? []),
          ],
        });
        const signature = JSON.stringify(language);
        if (!languageRegistrations.has(signature)) {
          monaco.languages.register(language);
          languageRegistrations.add(signature);
        }
        if (language.configuration)
          this.attempt(snapshot, "languages", () => {
            const configuration = languageConfiguration(
              readJson(snapshot, language.configuration!),
            );
            this.subscriptions.push(
              monaco.languages.setLanguageConfiguration(language.id, configuration),
            );
          });
      }
      for (const contribution of (snapshot.contributes.grammars ?? []) as GrammarContribution[])
        this.attempt(snapshot, "grammars", () => {
          const raw = textmate.parseRawGrammar(
            readResource(snapshot, contribution.path),
            contribution.path,
          );
          this.grammars.set(contribution.scopeName, { snapshot, contribution, raw });
          this.grammarEntries.push({ snapshot, contribution });
        });
      for (const contribution of (snapshot.contributes.themes ?? []) as ThemeContribution[]) {
        const id = contribution.id ?? contribution.label;
        this.themes.set(id, { snapshot, contribution });
        this.availableThemes.push({
          id,
          label: contribution.label,
          uiTheme: contribution.uiTheme,
          extensionId: snapshot.id,
        });
      }
      for (const contribution of (snapshot.contributes.iconThemes ??
        []) as IconThemeContribution[]) {
        this.iconThemes.set(contribution.id, { snapshot, contribution });
        this.availableIconThemes.push({
          id: contribution.id,
          label: contribution.label,
          extensionId: snapshot.id,
        });
      }
      for (const contribution of (snapshot.contributes.snippets ?? []) as {
        language: string;
        path: string;
      }[])
        this.attempt(snapshot, "snippets", () => {
          for (const [name, value] of Object.entries(readJson(snapshot, contribution.path)) as [
            string,
            any,
          ][]) {
            if (value.body === undefined || (value.prefix === undefined && !value.isFileTemplate))
              continue;
            const languages = contribution.language
              ? [contribution.language]
              : String(value.scope ?? "")
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean);
            for (const language of languages)
              this.snippets.push({
                extensionId: snapshot.id,
                language,
                name,
                prefixes:
                  value.prefix === undefined
                    ? []
                    : Array.isArray(value.prefix)
                      ? value.prefix
                      : [value.prefix],
                isFileTemplate: value.isFileTemplate === true,
                body: Array.isArray(value.body) ? value.body.join("\n") : value.body,
                description: Array.isArray(value.description)
                  ? value.description.join("\n")
                  : value.description,
              });
          }
        });
    }
    this.registry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: oniguruma.createOnigScanner,
        createOnigString: oniguruma.createOnigString,
      }),
      loadGrammar: async (scope) => this.grammars.get(scope)?.raw ?? null,
      getInjections: (scope) =>
        [...this.grammars]
          .filter(([, entry]) => entry.contribution.injectTo?.includes(scope))
          .map(([name]) => name),
    });
    for (const { contribution, snapshot } of this.grammarEntries) {
      if (!contribution.language) continue;
      try {
        const language = contribution.language;
        const injectedLanguages = this.grammarEntries
          .filter((entry) => entry.contribution.injectTo?.includes(contribution.scopeName))
          .map((entry) => entry.contribution.embeddedLanguages);
        const embeddedLanguages = Object.fromEntries(
          Object.entries(
            Object.assign({}, contribution.embeddedLanguages, ...injectedLanguages) as Record<
              string,
              string
            >,
          ).map(([scope, id]) => [scope, monaco.languages.getEncodedLanguageId(id)]),
        );
        const tokenTypes = Object.fromEntries(
          Object.entries(contribution.tokenTypes ?? {}).map(([scope, kind]) => [
            scope,
            ({ other: 0, comment: 1, string: 2, regex: 3 } as Record<string, 0 | 1 | 2 | 3>)[
              kind
            ] ?? 0,
          ]),
        );
        const grammar = await this.registry.loadGrammarWithConfiguration(
          contribution.scopeName,
          monaco.languages.getEncodedLanguageId(language),
          {
            embeddedLanguages,
            tokenTypes,
            balancedBracketSelectors: contribution.balancedBracketScopes,
            unbalancedBracketSelectors: contribution.unbalancedBracketScopes,
          },
        );
        if (!grammar) throw new Error(`Cannot load grammar ${contribution.scopeName}`);
        this.registeredGrammars.set(language, {
          extensionId: snapshot.id,
          scopeName: contribution.scopeName,
        });
        const readLineLimit = () => {
          const limit = options.getMaxTokenizationLineLength?.(language);
          return typeof limit === "number" && Number.isInteger(limit) && limit >= 0
            ? limit
            : 20_000;
        };
        let lineLimit = readLineLimit();
        const provider: monaco.languages.TokensProvider & monaco.languages.EncodedTokensProvider = {
          getInitialState: () => new TokenState(textmate.INITIAL),
          tokenize: (line, state) => {
            if (line.length >= lineLimit) {
              return { tokens: [{ startIndex: 0, scopes: "" }], endState: state };
            }
            const result = grammar.tokenizeLine(line, (state as TokenState).stack);
            return {
              tokens: result.tokens.map((token) => ({
                startIndex: token.startIndex,
                scopes: token.scopes.join(" "),
              })),
              endState: new TokenState(result.ruleStack),
            };
          },
          tokenizeEncoded: (line, state) => {
            if (line.length >= lineLimit) {
              return {
                tokens: grammar.tokenizeLine2("", textmate.INITIAL).tokens,
                endState: state,
              };
            }
            const result = grammar.tokenizeLine2(line, (state as TokenState).stack);
            return { tokens: result.tokens, endState: new TokenState(result.ruleStack) };
          },
        };
        // Cancel Monaco factories that can otherwise overwrite the synchronous TextMate provider later.
        this.subscriptions.push(
          monaco.languages.registerTokensProviderFactory(language, { create: () => provider }),
        );
        let registration = monaco.languages.setTokensProvider(language, provider);
        const stop = watch(readLineLimit, (limit) => {
          lineLimit = limit;
          registration.dispose();
          registration = monaco.languages.setTokensProvider(language, provider);
        });
        this.subscriptions.push({
          dispose() {
            stop();
            registration.dispose();
          },
        });
      } catch (error) {
        this.issues.push({ extensionId: snapshot.id, kind: "grammars", message: String(error) });
      }
    }
    for (const language of new Set(this.snippets.map((snippet) => snippet.language))) {
      const provider: monaco.languages.CompletionItemProvider & { _debugDisplayName: string } = {
        _debugDisplayName: "VS Code contributed snippets",
        provideCompletionItems: (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          return {
            suggestions: this.snippets
              .filter((snippet) => snippet.language === model.getLanguageId())
              .flatMap((snippet) =>
                snippet.prefixes.map((prefix) => ({
                  label: prefix,
                  detail: snippet.name,
                  documentation: snippet.description,
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  insertText: snippet.body,
                  insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                  range: model
                    .getLineContent(position.lineNumber)
                    .slice(0, position.column - 1)
                    .endsWith(prefix)
                    ? new monaco.Range(
                        position.lineNumber,
                        position.column - prefix.length,
                        position.lineNumber,
                        position.column,
                      )
                    : range,
                })),
              ),
          };
        },
      };
      this.subscriptions.push(monaco.languages.registerCompletionItemProvider(language, provider));
    }
    for (const [index, snippet] of this.snippets.entries()) {
      if (!snippet.isFileTemplate) continue;
      snippet.actionId = `${this.namePrefix}.fillFile.${index}`;
      this.subscriptions.push(
        monaco.editor.addEditorAction({
          id: snippet.actionId,
          label: `Fill File: ${snippet.description ?? snippet.name}`,
          contextMenuGroupId: "9_snippets",
          precondition: `editorLangId == ${snippet.language}`,
          run: (editor) => {
            const model = editor.getModel();
            if (!model) return;
            const controller = editor.getContribution<{
              insert(template: string): void;
              dispose(): void;
            }>("snippetController2");
            if (!controller) throw new Error("Monaco snippet insertion is unavailable");
            editor.setSelection(model.getFullModelRange());
            controller.insert(snippet.body);
          },
        }),
      );
    }
    const defaultTheme = options.theme ?? (this.themeKind === "dark" ? "Dark+" : "Light+");
    if (this.themes.has(defaultTheme)) this.setTheme(defaultTheme);
    else if (this.availableThemes[0]) this.setTheme(this.availableThemes[0].id);
    const defaultIconTheme = options.iconTheme ?? "vs-seti";
    if (this.iconThemes.has(defaultIconTheme)) this.setIconTheme(defaultIconTheme);
    activeContributions.value = this;
  }

  private attempt(snapshot: ExtensionContributionSnapshot, kind: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.issues.push({ extensionId: snapshot.id, kind, message: String(error) });
    }
  }

  getLanguageId(path: string, firstLine = ""): string | undefined {
    const name = path.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
    const values = [...this.registeredLanguages.values()];
    const filename = values.find((language) =>
      language.filenames?.some((file) => file.toLowerCase() === name),
    );
    if (filename) return filename.id;
    const pattern = values.find((language) =>
      language.filenamePatterns?.some((glob) =>
        picomatch(glob, { dot: true, nocase: true })(glob.includes("/") ? path : name),
      ),
    );
    if (pattern) return pattern.id;
    const extension = values
      .flatMap((language) => (language.extensions ?? []).map((suffix) => ({ language, suffix })))
      .filter(({ suffix }) => name.endsWith(suffix.toLowerCase()))
      .sort((a, b) => b.suffix.length - a.suffix.length)[0];
    if (extension) return extension.language.id;
    return values.find(
      (language) => language.firstLine && regex(language.firstLine)?.test(firstLine),
    )?.id;
  }

  get colorTheme(): ContributedColorTheme | undefined {
    return this.appliedColorTheme;
  }

  get themeName(): string | undefined {
    return this.appliedColorTheme && this.monacoThemeName(this.appliedColorTheme.id);
  }

  private monacoThemeName(id: string): string {
    return `${this.namePrefix}-${id.replace(/[^a-z0-9-]/gi, "-")}`;
  }

  setTheme(id: string): void {
    const entry = this.themes.get(id);
    if (!entry) throw new Error(`Unknown contributed color theme: ${id}`);
    const loading = new Set<string>();
    const read = (path: string): any => {
      const key = normalizePath(path);
      if (loading.has(key)) throw new Error(`Circular color theme include: ${key}`);
      loading.add(key);
      const data = readJson(entry.snapshot, key);
      const parent =
        typeof data.include === "string" ? read(relativeResource(key, data.include)) : {};
      loading.delete(key);
      if (typeof data.tokenColors === "string")
        throw new Error(`External token-color plist is not supported: ${data.tokenColors}`);
      return {
        ...parent,
        ...data,
        colors: { ...parent.colors, ...data.colors },
        tokenColors: [...(parent.tokenColors ?? []), ...(data.tokenColors ?? [])],
      };
    };
    const data = read(entry.contribution.path);
    const uiTheme = entry.contribution.uiTheme;
    const themeName = this.monacoThemeName(id);
    this.registry.setTheme({
      name: id,
      settings: [
        {
          settings: {
            foreground: data.colors["editor.foreground"],
            background: data.colors["editor.background"],
          },
        },
        ...data.tokenColors,
      ],
    });
    monaco.editor.defineTheme(themeName, {
      base: uiTheme,
      inherit: true,
      rules: [],
      colors: data.colors,
      encodedTokensColors: this.registry.getColorMap().slice(1),
    });
    monaco.editor.setTheme(themeName);
    monaco.languages.setColorMap(this.registry.getColorMap());
    if (this.root) {
      const aliases: Record<string, string> = {
        bg: "editor.background",
        surface: "sideBar.background",
        raised: "editorWidget.background",
        input: "input.background",
        border: "panel.border",
        fg: "foreground",
        strong: "editor.foreground",
        muted: "descriptionForeground",
        accent: "textLink.foreground",
        button: "button.background",
        "button-hover": "button.hoverBackground",
        selected: "list.inactiveSelectionBackground",
        "active-selection": "list.activeSelectionBackground",
        "selection-border": "focusBorder",
        "drop-background": "list.dropBackground",
        "warning-fg": "editorWarning.foreground",
        "warning-bg": "inputValidation.warningBackground",
        "scrollbar-thumb": "scrollbarSlider.background",
        "scrollbar-thumb-hover": "scrollbarSlider.hoverBackground",
        "scrollbar-thumb-active": "scrollbarSlider.activeBackground",
      };
      const values = {
        ...Object.fromEntries(
          Object.entries(data.colors as Record<string, string>)
            .filter(([, color]) => typeof color === "string")
            .map(([key, color]) => [`--vscode-${key.replaceAll(".", "-")}`, color]),
        ),
        ...Object.fromEntries(
          Object.entries(aliases)
            .filter(([, key]) => typeof data.colors[key] === "string")
            .map(([alias, key]) => [`--${alias}`, data.colors[key]]),
        ),
      };
      for (const name of this.cssValues.keys())
        if (!(name in values)) this.root.style.removeProperty(name);
      this.cssValues.clear();
      for (const [name, value] of Object.entries(values)) {
        this.root.style.setProperty(name, value as string);
        this.cssValues.set(name, value as string);
      }
    }
    this.appliedColorTheme = { id, uiTheme };
    this.themeKind = uiTheme === "vs" || uiTheme === "hc-light" ? "light" : "dark";
    if (activeContributions.value === this) triggerRef(activeContributions);
  }

  setIconTheme(id: string): void {
    const entry = this.iconThemes.get(id);
    if (!entry) throw new Error(`Unknown contributed file icon theme: ${id}`);
    const data = readJson(entry.snapshot, entry.contribution.path);
    this.iconData = data;
    this.iconClassPrefix = `i-${this.namePrefix}-icon-`;
    const resourceUrl = (path: string) => {
      const asset = entry.snapshot.resources[relativeResource(entry.contribution.path, path)];
      if (!asset) throw new Error(`Missing icon asset: ${path}`);
      return `data:${asset.mimeType};${asset.encoding === "base64" ? "base64," + asset.contents : "charset=utf-8," + encodeURIComponent(asset.contents)}`;
    };
    const css: string[] = [];
    for (const font of data.fonts ?? [])
      css.push(
        `@font-face{font-family:${JSON.stringify(this.namePrefix + font.id)};src:${font.src.map((source: any) => `url(${JSON.stringify(resourceUrl(source.path))}) format(${JSON.stringify(source.format)})`).join(",")};font-weight:${font.weight ?? "normal"};font-style:${font.style ?? "normal"}}`,
      );
    for (const [key, definition] of Object.entries(data.iconDefinitions ?? {}) as [string, any][]) {
      const selector = `.${this.iconClassPrefix}${key.replace(/[^a-z0-9_-]/gi, "-")}`;
      if (definition.iconPath)
        css.push(
          `${selector}{background-image:url(${JSON.stringify(resourceUrl(definition.iconPath))})!important;background-size:contain;background-repeat:no-repeat;background-position:center;mask:none!important}`,
        );
      else if (definition.fontCharacter) {
        const font =
          data.fonts?.find((item: any) => item.id === definition.fontId) ?? data.fonts?.[0];
        css.push(
          `${selector}{mask:none!important;background:none!important;color:${definition.fontColor ?? "inherit"}!important}${selector}::before{content:${cssContent(definition.fontCharacter)};font-family:${JSON.stringify(this.namePrefix + font?.id)};font-size:${definition.fontSize ?? font?.size ?? "150%"}}`,
        );
      }
    }
    this.iconStyle?.remove();
    this.iconStyle = document.createElement("style");
    this.iconStyle.dataset.vscodeIconTheme = id;
    this.iconStyle.textContent = css.join("\n");
    document.head.appendChild(this.iconStyle);
    if (activeContributions.value === this) triggerRef(activeContributions);
  }

  getFileIconClass(
    path: string,
    options: { folder?: boolean; expanded?: boolean; root?: boolean } = {},
  ): string | undefined {
    if (!this.iconData) return undefined;
    const light = this.themeKind === "light" ? this.iconData.light : undefined;
    const data = { ...this.iconData, ...light };
    const lookup = (field: string, name: string) =>
      light?.[field]?.[name] ?? this.iconData[field]?.[name];
    const name = path.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
    let key: string | undefined;
    if (options.folder) {
      if (options.root)
        key =
          (options.expanded ? lookup("rootFolderNamesExpanded", name) : undefined) ??
          lookup("rootFolderNames", name) ??
          (options.expanded ? (data.rootFolderExpanded ?? data.folderExpanded) : undefined) ??
          data.rootFolder ??
          data.folder;
      else
        key =
          (options.expanded ? lookup("folderNamesExpanded", name) : undefined) ??
          lookup("folderNames", name) ??
          (options.expanded ? data.folderExpanded : undefined) ??
          data.folder;
    } else {
      key = lookup("fileNames", name);
      if (!key) {
        const extension = [
          ...new Set([
            ...Object.keys(this.iconData.fileExtensions ?? {}),
            ...Object.keys(light?.fileExtensions ?? {}),
          ]),
        ]
          .sort((a, b) => b.length - a.length)
          .find((extension) => name.endsWith("." + extension));
        if (extension) key = lookup("fileExtensions", extension);
      }
      key ??= lookup("languageIds", this.getLanguageId(path) ?? "") ?? data.file;
    }
    return key ? this.iconClassPrefix + key.replace(/[^a-z0-9_-]/gi, "-") : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.registry?.dispose();
    this.iconStyle?.remove();
    for (const [name, value] of this.cssValues)
      if (this.root?.style.getPropertyValue(name) === value) this.root.style.removeProperty(name);
    if (activeContributions.value === this) activeContributions.value = undefined;
  }
}

export async function createExtensionContributions(
  snapshots: readonly ExtensionContributionSnapshot[],
  options: {
    theme?: string;
    themeKind?: "dark" | "light";
    iconTheme?: string;
    colorTarget?: HTMLElement;
    getMaxTokenizationLineLength?: (languageId: string) => number | undefined;
  } = {},
): Promise<ExtensionContributions> {
  const adapter = new ExtensionContributions(options);
  try {
    await adapter.load(snapshots, options);
    return adapter;
  } catch (error) {
    adapter.dispose();
    throw error;
  }
}
