```ts
interface ScmResource {
  readonly resourceUri: {
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;
    toString(): string;
  };
  readonly command?: { readonly command: string; readonly tooltip?: string };
  readonly decorations?: {
    readonly tooltip?: string;
    readonly strikeThrough?: boolean;
    readonly faded?: boolean;
  };
  readonly contextValue?: string;
}

interface ScmGroup {
  readonly label: string;
  readonly resources: readonly (string | ScmResource)[]; // A string is a workspace file path.
  readonly hideWhenEmpty?: boolean;
}

// Extensible: provider sources may supply their own descriptors.
interface ScmProvider {
  readonly handle: number | string;
  readonly label: string;
  inputValue: string;
  readonly inputPlaceholder?: string;
  readonly acceptInputCommand?: { readonly command: string };
  readonly groups: ReadonlyMap<string, ScmGroup>;
}

type ScmMenuContext = { readonly provider: ScmProvider } & (
  | { readonly group?: undefined; readonly resource?: undefined }
  | { readonly group: ScmGroup; readonly groupId: string; readonly resource?: string | ScmResource }
);

class UiScmService {
  readonly menu: Menu<ScmMenuContext, "resource" | "clipboard" | "groups">; // 各组定义默认项，context 携带实际目标
  readonly collapsedGroups: Ref<ReadonlySet<string>>;
  isMenuTargetCurrent(context: ScmMenuContext): boolean; // provider、group、resource 仍在当前数据中
  submitInput(provider: ScmProvider): void;
  toggleGroup(provider: ScmProvider, groupId: string): void;
  readonly providers: ComputedRef<ScmProvider[]>;
  registerProviderSource(source: () => readonly ScmProvider[]): () => void;
  openResource(resource: string | ScmResource): Promise<void>; // Runs the resource action or opens the workspace file.
}

export { default as ChangesPanel } from "./ChangesPanel.vue";
```
