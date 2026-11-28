import { shallowRef } from "vue";

export interface ContributedColorTheme {
  readonly id: string;
  readonly uiTheme: "vs" | "vs-dark" | "hc-black" | "hc-light";
}

type ContributionConsumer = {
  readonly colorTheme: ContributedColorTheme | undefined;
  readonly availableThemes: readonly {
    id: string;
    label: string;
    uiTheme: string;
    extensionId: string;
  }[];
  readonly availableIconThemes: readonly { id: string; label: string; extensionId: string }[];
  getLanguageId(path: string, firstLine?: string): string | undefined;
  readonly themeName: string | undefined;
  getFileIconClass(
    path: string,
    options?: { folder?: boolean; expanded?: boolean; root?: boolean },
  ): string | undefined;
};
export const activeContributions = shallowRef<ContributionConsumer | undefined>();
let contributionUpdate: Promise<void> = Promise.resolve();
export function queueContributionUpdate(update: () => Promise<void>): Promise<void> {
  const pending = contributionUpdate.then(update, update);
  contributionUpdate = pending;
  return pending;
}
export function getContributedLanguageId(path: string, firstLine = ""): string | undefined {
  return activeContributions.value?.getLanguageId(path, firstLine);
}
export function getContributedThemeName(): string | undefined {
  return activeContributions.value?.themeName;
}
export function getContributedFileIconClass(
  path: string,
  options?: { folder?: boolean; expanded?: boolean; root?: boolean },
): string | undefined {
  return activeContributions.value?.getFileIconClass(path, options);
}
