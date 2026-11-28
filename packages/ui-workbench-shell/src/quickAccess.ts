/* UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: QuickPick. Adaptation: local prefix dispatch, workspace files and Monaco navigation; preview cancellation follows VS Code editorNavigationQuickAccess. */
// @unocss-include
import { computed, nextTick, ref, shallowRef, watch, type Ref } from "vue";
import type { editor, languages, IRange } from "monaco-editor";
import type { QuickAccessItem } from "@harness/ui-commands";
import { FileEditorService, openFileEditorTab } from "@harness/ui-editor";
import type { UiTabsService, UiWorkbenchService, WorkbenchAction } from "@harness/ui-workbench";
import type { UiWorkspaceService } from "@harness/ui-workspace";

const symbolIcons = [
  "i-codicon-symbol-file", "i-codicon-symbol-namespace", "i-codicon-symbol-namespace",
  "i-codicon-symbol-namespace", "i-codicon-symbol-class", "i-codicon-symbol-method",
  "i-codicon-symbol-property", "i-codicon-symbol-field", "i-codicon-symbol-method",
  "i-codicon-symbol-enum", "i-codicon-symbol-interface", "i-codicon-symbol-method",
  "i-codicon-symbol-variable", "i-codicon-symbol-constant", "i-codicon-symbol-string",
  "i-codicon-symbol-numeric", "i-codicon-symbol-boolean", "i-codicon-symbol-array",
  "i-codicon-symbol-namespace", "i-codicon-symbol-key", "i-codicon-symbol-boolean",
  "i-codicon-symbol-enum-member", "i-codicon-symbol-structure", "i-codicon-symbol-event",
  "i-codicon-symbol-operator", "i-codicon-symbol-parameter",
];

export function useQuickAccess(
  open: Ref<boolean>,
  commands: Ref<WorkbenchAction[]>,
  files: FileEditorService,
  tabs: UiTabsService,
  workspace: UiWorkspaceService,
  workbench: UiWorkbenchService,
  currentTab: () => string,
) {
  const query = ref(">");
  const mode = computed(() => {
    const prefix = query.value[0];
    return prefix === ">" || prefix === "@" || prefix === ":" || prefix === "?" ? prefix : "";
  });
  const search = computed(() =>
    mode.value === ":" || mode.value === "?" ? "" : query.value.slice(mode.value.length).trim(),
  );
  const loading = ref(false);
  const error = ref("");
  const truncated = ref(false);
  const foundFiles = shallowRef<QuickAccessItem[]>([]);
  const symbols = shallowRef<QuickAccessItem[]>([]);
  const target = shallowRef<editor.IStandaloneCodeEditor>();
  let targetTab = "";
  let originalView: editor.ICodeEditorViewState | null = null;
  let accepted = false;

  function restoreView() {
    if (target.value?.getModel() && originalView) target.value.restoreViewState(originalView);
  }

  watch(open, (value) => {
    if (value) {
      accepted = false;
      targetTab = currentTab();
      target.value = files.getEditorView(targetTab);
      originalView = target.value?.saveViewState() ?? null;
    } else if (!accepted) restoreView();
  }, { flush: "sync" });
  watch(mode, (_, previous) => {
    loading.value = false;
    error.value = "";
    if (open.value && (previous === "@" || previous === ":")) restoreView();
  }, { flush: "sync" });

  function navigationItem(
    id: string,
    title: string,
    range: IRange,
    description?: string,
  ): QuickAccessItem {
    const view = target.value!;
    const tabId = targetTab;
    return {
      id,
      title,
      description,
      icon: "i-codicon-symbol-method",
      preview: () => {
        if (view.getModel()) view.revealRangeInCenter(range);
      },
      run: () => {
        if (!view.getModel()) return;
        const group = tabs.groups.value.find((group) => group.activeTabId === tabId);
        if (group) tabs.focusGroup(group.id);
        view.setSelection(range);
        view.revealRangeInCenter(range);
        view.focus();
      },
    };
  }

  function fileItem(root: string, relativePath: string): QuickAccessItem {
    const name = relativePath.split("/").at(-1)!;
    const directory = relativePath.slice(0, -(name.length + 1));
    return {
      id: `file:${root}/${relativePath}`,
      title: name,
      description: [
        workspace.activeRoots.value.length > 1 ? root.split("/").at(-1) : "",
        directory,
      ].filter(Boolean).join(" / "),
      searchText: relativePath,
      icon: workbench.getFileIconClass(`${root}/${relativePath}`) || "i-codicon-file",
      run: async () => {
        await openFileEditorTab(tabs, files, { root, relativePath, preview: true });
        await nextTick();
        const tabId = tabs.groups.value.find((group) => group.isActive)?.activeTabId;
        if (tabId) files.getEditorView(tabId)?.focus();
      },
    };
  }

  watch([open, mode], async ([visible, prefix], _, onCleanup) => {
    symbols.value = [];
    if (!visible || prefix !== "@" || !target.value) return;
    let stale = false;
    onCleanup(() => { stale = true; });
    loading.value = true;
    error.value = "";
    try {
      const result = await files.getDocumentSymbols(targetTab);
      if (stale) return;
      const items: QuickAccessItem[] = [];
      function collect(entries: languages.DocumentSymbol[], container = "") {
        for (const symbol of entries) {
          const range = symbol.selectionRange ?? symbol.range;
          const item = navigationItem(
            `symbol:${items.length}`,
            symbol.name,
            range,
            container || symbol.containerName || symbol.detail,
          );
          item.icon = symbolIcons[symbol.kind] ?? "i-codicon-symbol-misc";
          items.push(item);
          if (symbol.children) collect(symbol.children, symbol.name);
        }
      }
      collect(result);
      symbols.value = items;
    } catch (cause) {
      if (!stale) error.value = cause instanceof Error ? cause.message : "Could not load symbols.";
    } finally {
      if (!stale) loading.value = false;
    }
  });

  watch([open, mode, search, workspace.activeRoots], ([visible, prefix, value], _, onCleanup) => {
    if (!visible || prefix) return;
    const controller = new AbortController();
    foundFiles.value = [...files.documents.values()]
      .filter((doc) => workspace.activeRoots.value.includes(doc.root))
      .reverse().map((doc) => fileItem(doc.root, doc.relativePath));
    error.value = "";
    truncated.value = false;
    loading.value = false;
    if (!value && foundFiles.value.length) return;
    loading.value = true;
    const timer = setTimeout(async () => {
      try {
        const results = await Promise.allSettled(
          workspace.activeRoots.value.map(async (root) => ({
            root,
            ...await workspace.getRoot(root).searchFiles(value, controller.signal),
          })),
        );
        if (controller.signal.aborted) return;
        const entries = new Map(foundFiles.value.map((item) => [item.id, item]));
        for (const result of results) {
          if (result.status === "rejected") {
            error.value = "Could not search one or more workspace folders.";
            continue;
          }
          if (result.value.truncated) truncated.value = true;
          for (const path of result.value.paths) {
            const item = fileItem(result.value.root, path);
            if (!entries.has(item.id)) entries.set(item.id, item);
          }
        }
        foundFiles.value = [...entries.values()];
      } catch (cause) {
        if (!controller.signal.aborted) {
          error.value = cause instanceof Error ? cause.message : "Could not search files.";
        }
      } finally {
        if (!controller.signal.aborted) loading.value = false;
      }
    }, 100);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });

  const lineItem = computed(() => {
    const model = target.value?.getModel();
    if (mode.value !== ":" || !model) return undefined;
    const match = /^:(-?\d+)(?:[:,#](-?\d+))?\s*$/.exec(query.value);
    if (!match) return undefined;
    let line = Number(match[1]);
    if (line < 0) line = model.getLineCount() + line + 1;
    line = Math.max(1, Math.min(model.getLineCount(), line));
    const requestedColumn = Math.max(1, Number(match[2] ?? 1));
    const content = model.getLineContent(line);
    let column = 1;
    let visibleColumn = 1;
    const tabSize = model.getOptions().tabSize;
    for (const character of content) {
      if (visibleColumn >= requestedColumn) break;
      visibleColumn += character === "\t" ? tabSize - (visibleColumn - 1) % tabSize : character.length;
      column += character.length;
    }
    const item = navigationItem("line", `Go to line ${line}, column ${visibleColumn}`, {
      startLineNumber: line,
      endLineNumber: line,
      startColumn: column,
      endColumn: column,
    });
    item.icon = "i-codicon-go-to-file";
    return item;
  });

  const help: QuickAccessItem[] = [
    { id: "files", title: "", prefix: "", description: "Go to File", icon: "", run() {} },
    { id: "commands", title: ">", prefix: ">", description: "Show and Run Commands", icon: "", run() {} },
    { id: "symbols", title: "@", prefix: "@", description: "Go to Symbol in Editor", icon: "", run() {} },
    { id: "line", title: ":", prefix: ":", description: "Go to Line/Column", icon: "", run() {} },
  ];
  const items = computed(() => {
    if (mode.value === ">") return commands.value;
    if (mode.value === "?") return help;
    if (mode.value === "@") return symbols.value;
    if (mode.value === ":") return lineItem.value ? [lineItem.value] : [];
    return foundFiles.value;
  });
  const label = computed(() => ({
    ">": "Search commands",
    "@": "Search symbols",
    ":": "Go to line",
    "?": "Quick Access help",
    "": "Search files",
  })[mode.value]);
  const placeholder = computed(() => ({
    ">": "Type the name of a command to run.",
    "@": "Type the name of a symbol to go to.",
    ":": "Type a line number, optionally followed by :column.",
    "?": "Select a Quick Access mode.",
    "": "Search files by name (type ? for help).",
  })[mode.value]);
  const emptyText = computed(() => {
    if (error.value && (mode.value === "" || mode.value === "@")) return error.value;
    if (mode.value === ">") return "No matching commands.";
    if (mode.value === "@") {
      return target.value ? "No matching symbols in this editor." : "Open a text file to go to a symbol.";
    }
    if (mode.value === ":") {
      return target.value
        ? `Enter a line number between 1 and ${target.value.getModel()?.getLineCount() ?? 1}.`
        : "Open a text file to go to a line.";
    }
    return workspace.activeRoots.value.length ? "No matching files." : "Open a workspace to search files.";
  });
  return {
    query, items, search, label, placeholder, emptyText,
    loading: computed(() => (mode.value === "" || mode.value === "@") && loading.value),
    hint: computed(() => mode.value === ""
      ? error.value || (truncated.value ? "More files match. Keep typing to narrow the results." : undefined)
      : undefined),
    accept: () => { accepted = true; },
    show(prefix: string) { query.value = prefix; open.value = true; },
  };
}
