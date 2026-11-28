import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Uri } from "@harness/vscode-types";

type MessageArgument = string | number | boolean;
type MessageArguments = readonly MessageArgument[] | Record<string, MessageArgument>;

export interface LocalizationBundle {
  readonly uri: Uri;
  readonly contents: Record<string, string>;
}

export async function loadLocalizationBundle(
  extensionPath: string,
  directory: unknown,
  language: string,
): Promise<LocalizationBundle | undefined> {
  const locale = language.toLowerCase();
  if (
    locale === "en" ||
    typeof directory !== "string" ||
    !directory ||
    !/^[a-z]+(?:-[a-z0-9]+)*$/.test(locale)
  ) {
    return undefined;
  }

  const folder = resolve(extensionPath, directory);
  const relativeFolder = relative(extensionPath, folder);
  if (
    relativeFolder === ".." ||
    relativeFolder.startsWith(`..${sep}`) ||
    isAbsolute(relativeFolder)
  )
    return undefined;

  for (const parts = locale.split("-"); parts.length; parts.pop()) {
    const languageTag = parts.join("-");
    if (languageTag === "en") break;
    const file = join(folder, `bundle.l10n.${languageTag}.json`);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const contents = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      return { uri: Uri.file(file), contents };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        console.warn(
          `Failed to load extension localization bundle ${file}`,
          error instanceof Error ? error.message : String(error),
        );
    }
  }
  return undefined;
}

export function createLocalization(getBundle: () => LocalizationBundle | undefined) {
  return {
    get bundle() {
      return getBundle()?.contents;
    },
    get uri() {
      return getBundle()?.uri;
    },
    t(
      messageOrOptions:
        | string
        | { message: string; args?: MessageArguments; comment: string | readonly string[] },
      ...args: (MessageArgument | Record<string, MessageArgument>)[]
    ): string {
      const options = typeof messageOrOptions === "string" ? undefined : messageOrOptions;
      const message =
        typeof messageOrOptions === "string" ? messageOrOptions : messageOrOptions.message;
      const comment = options?.comment;
      const suffix = typeof comment === "string" ? comment : comment?.join("");
      const key = suffix ? `${message}/${suffix}` : message;
      const contents = getBundle()?.contents;
      const translated = contents && Object.hasOwn(contents, key) ? contents[key] : undefined;
      const template = translated ?? message;
      const values = options
        ? (options.args ?? [])
        : args.length === 1 && typeof args[0] === "object"
          ? args[0]
          : args;
      if (!values || !Object.keys(values).length) return template;
      return template.replace(/\{([^}]+)\}/g, (match, field: string) => {
        if (!Object.hasOwn(values, field)) return match;
        const value = (values as Record<string, MessageArgument>)[field];
        return value === undefined ? match : String(value);
      });
    },
  };
}

export const l10n = createLocalization(() => undefined);
