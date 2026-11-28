import { inject } from "@harness/di";
import {
  FileEditorService,
  FileEditorTabDescriptor,
  openFileEditorTab,
  type EditorDocument,
} from "@harness/ui-editor";
import { UiTabsService } from "@harness/ui-workbench";
import * as monaco from "monaco-editor";
import { SnippetController2 } from "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js";
import {
  computed,
  onScopeDispose,
  shallowReactive,
  shallowRef,
  unref,
  watch,
  type ComputedRef,
} from "vue";
import {
  TabGroupsData,
  TextEditorSelectionChangeKind,
  type TextDocumentData,
  type TextDocumentSnapshot,
  Uri,
  type ResolvedTextEditorOptions,
  type SnippetString,
  type TabGroupsSnapshot,
  type TextEditorOptions,
  type WindowState,
} from "@harness/vscode-types";
import {
  EventEmitter,
  Position,
  Range,
  Selection,
  TextDocument,
  VscodeWorkspaceCompatService,
  type Disposable,
} from "./index.ts";
import { associateFileModel } from "./model-uri.ts";
import { VirtualTextEditorTab, VirtualTextEditorTabs } from "./virtual-text-editor-tabs.ts";
import { applyEditorOptions, observeEditorOptions, readEditorOptions } from "./editor-options.ts";

export interface TextEditorDecorationType extends Disposable {
  readonly key: string;
}

export interface DecorationRenderOptions {
  backgroundColor?: string | { id: string };
  color?: string | { id: string };
  border?: string;
  borderColor?: string | { id: string };
  borderStyle?: string;
  borderWidth?: string;
  borderRadius?: string;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
  cursor?: string;
  opacity?: string;
  isWholeLine?: boolean;
  light?: DecorationRenderOptions;
  dark?: DecorationRenderOptions;
}

export interface TextEditorEdit {
  replace(location: Range | Position, value: string): void;
  insert(location: Position, value: string): void;
  delete(location: Range): void;
  setEndOfLine(endOfLine: 1 | 2): void;
}

export interface DecorationOptions {
  readonly range: Range;
  readonly hoverMessage?:
    | string
    | { value: string; isTrusted?: boolean }
    | readonly { value: string; isTrusted?: boolean }[];
}

export interface TextDocumentShowOptions {
  readonly label?: string;
  readonly viewColumn?: number;
  readonly preserveFocus?: boolean;
  readonly preview?: boolean;
  readonly selection?: Range;
}

function toMonacoRange(range: Range): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}
function fromMonacoRange(range: monaco.IRange): Range {
  return new Range(
    new Position(range.startLineNumber - 1, range.startColumn - 1),
    new Position(range.endLineNumber - 1, range.endColumn - 1),
  );
}
function fromMonacoSelection(selection: monaco.Selection): Selection {
  return new Selection(
    new Position(selection.selectionStartLineNumber - 1, selection.selectionStartColumn - 1),
    new Position(selection.positionLineNumber - 1, selection.positionColumn - 1),
  );
}

function selectionChangeKind(source: string): TextEditorSelectionChangeKind | undefined {
  switch (source) {
    case "keyboard":
      return TextEditorSelectionChangeKind.Keyboard;
    case "mouse":
      return TextEditorSelectionChangeKind.Mouse;
    case "api":
    case "code.jump":
    case "code.navigation":
      return TextEditorSelectionChangeKind.Command;
  }
  return undefined;
}

export class TextEditor {
  private readonly decorationIds = new Map<string, string[]>();
  constructor(
    private readonly documentSource: TextDocumentData | ComputedRef<TextDocumentData>,
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    private readonly decorationOptions: (key: string) => DecorationRenderOptions | undefined = () =>
      undefined,
  ) {}

  get document(): TextDocumentData {
    return unref(this.documentSource);
  }

  get selection(): Selection {
    const selection = this.editor.getSelection();
    return selection
      ? fromMonacoSelection(selection)
      : new Selection(new Position(0, 0), new Position(0, 0));
  }
  set selection(value: Selection) {
    this.selections = [value];
  }
  get selections(): readonly Selection[] {
    return (this.editor.getSelections() ?? []).map(fromMonacoSelection);
  }
  set selections(values: readonly Selection[]) {
    if (!values.length) throw new Error("selections must not be empty");
    this.editor.setSelections(
      values.map((selection) => ({
        selectionStartLineNumber: selection.anchor.line + 1,
        selectionStartColumn: selection.anchor.character + 1,
        positionLineNumber: selection.active.line + 1,
        positionColumn: selection.active.character + 1,
      })),
    );
  }
  get visibleRanges(): readonly Range[] {
    return this.editor.getVisibleRanges().map(fromMonacoRange);
  }
  get viewColumn(): number | undefined {
    return undefined;
  }
  get diffInformation(): undefined {
    return undefined;
  }
  get options(): ResolvedTextEditorOptions {
    return readEditorOptions(this.editor);
  }
  set options(value: TextEditorOptions) {
    applyEditorOptions(this.editor, value);
  }

  async insertSnippet(
    snippet: SnippetString,
    location?: Position | Range | readonly Position[] | readonly Range[],
    options: { undoStopBefore?: boolean; undoStopAfter?: boolean } = {},
  ): Promise<boolean> {
    const model = this.editor.getModel();
    if (!model || this.editor.getOption(monaco.editor.EditorOption.readOnly)) return false;
    if (typeof snippet?.value !== "string") throw new TypeError("Invalid snippet");
    if (location !== undefined) {
      const locations: readonly (Position | Range)[] = Array.isArray(location)
        ? location
        : [location as Position | Range];
      if (!locations.length) return false;
      const ranges = locations.map((value) =>
        model.validateRange(
          toMonacoRange(
            Range.isRange(value)
              ? Range.of(value)
              : new Range(Position.of(value), Position.of(value)),
          ),
        ),
      );
      const sorted = [...ranges].sort(monaco.Range.compareRangesUsingStarts);
      for (let i = 1; i < sorted.length; i++) {
        if (monaco.Range.areIntersecting(sorted[i - 1]!, sorted[i]!))
          throw new Error("Overlapping ranges are not allowed");
      }
      this.editor.setSelections(ranges.map((range) => monaco.Selection.fromRange(range)));
    }
    const controller = SnippetController2.get(this.editor);
    if (!controller) throw new Error("Snippet controller is unavailable");
    controller.insert(snippet.value, options);
    return true;
  }

  async edit(
    callback: (editBuilder: TextEditorEdit) => void,
    options: { undoStopBefore?: boolean; undoStopAfter?: boolean } = {},
  ): Promise<boolean> {
    const model = this.editor.getModel();
    if (!model || this.editor.getOption(monaco.editor.EditorOption.readOnly)) return false;
    const version = model.getVersionId();
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    let endOfLine: 1 | 2 | undefined;
    let active = true;
    const add = (range: Range, text: string) => {
      if (!active) throw new Error("Edit builder can only be used during the callback");
      edits.push({ range: toMonacoRange(range), text, forceMoveMarkers: true });
    };
    try {
      callback({
        replace: (location, text) =>
          add(location instanceof Position ? new Range(location, location) : location, text),
        insert: (location, text) => add(new Range(location, location), text),
        delete: (range) => add(range, ""),
        setEndOfLine: (value) => {
          if (!active) throw new Error("Edit builder can only be used during the callback");
          if (value !== 1 && value !== 2) throw new Error("Invalid end of line sequence");
          endOfLine = value;
        },
      });
    } finally {
      active = false;
    }
    if (model !== this.editor.getModel() || model.getVersionId() !== version) return false;
    const ranges = edits
      .map((edit) => model.validateRange(edit.range))
      .sort(monaco.Range.compareRangesUsingStarts);
    for (let i = 1; i < ranges.length; i++) {
      if (monaco.Range.areIntersecting(ranges[i - 1]!, ranges[i]!))
        throw new Error("Overlapping ranges are not allowed");
    }
    if (options.undoStopBefore !== false) this.editor.pushUndoStop();
    const applied = !edits.length || this.editor.executeEdits("vscode-compat", edits);
    if (applied && endOfLine)
      model.pushEOL(
        endOfLine === 2 ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
      );
    if (options.undoStopAfter !== false) this.editor.pushUndoStop();
    return applied;
  }

  revealRange(range: Range, revealType = 0): void {
    const converted = toMonacoRange(range);
    if (revealType === 1) this.editor.revealRangeInCenter(converted);
    else if (revealType === 2) this.editor.revealRangeInCenterIfOutsideViewport(converted);
    else if (revealType === 3) this.editor.revealRangeAtTop(converted);
    else this.editor.revealRange(converted);
  }
  focus(): void {
    this.editor.focus();
  }

  clearDecoration(key: string): void {
    this.editor.deltaDecorations(this.decorationIds.get(key) ?? [], []);
    this.decorationIds.delete(key);
  }

  setDecorations(
    decorationType: TextEditorDecorationType,
    rangesOrOptions: readonly (Range | DecorationOptions)[],
  ): void {
    const options = this.decorationOptions(decorationType.key);
    const next = this.editor.deltaDecorations(
      this.decorationIds.get(decorationType.key) ?? [],
      rangesOrOptions.map((item) => {
        const range = "range" in item ? item.range : item;
        const hover = "range" in item ? item.hoverMessage : undefined;
        return {
          range: toMonacoRange(range),
          options: {
            isWholeLine: options?.isWholeLine,
            className: options?.isWholeLine ? decorationType.key : undefined,
            inlineClassName: options?.isWholeLine ? undefined : decorationType.key,
            hoverMessage:
              typeof hover === "string"
                ? { value: hover }
                : Array.isArray(hover)
                  ? [...hover]
                  : (hover as { value: string; isTrusted?: boolean } | undefined),
          },
        };
      }),
    );
    this.decorationIds.set(decorationType.key, next);
  }
}

export class VscodeWindowCompatService {
  private readonly editorService = inject(FileEditorService);
  private readonly unregisterEditorHook = this.editorService.registerEditorHook((path, editor) =>
    this.registerMonacoEditor(path, editor as monaco.editor.IStandaloneCodeEditor),
  );
  private readonly workspaceCompat = inject(VscodeWorkspaceCompatService);
  private readonly tabs = inject(UiTabsService);
  private readonly editorInstances = shallowReactive(
    new Map<EditorDocument | TextDocumentData, TextEditor>(),
  );
  private readonly activeDocument = shallowRef<EditorDocument | TextDocumentData | null>(null);
  private readonly virtualTabs = new VirtualTextEditorTabs(this.tabs, (document, editor) =>
    this.attachEditor(document, document, editor),
  );
  private readonly activeEditorEmitter = new EventEmitter<TextEditor | undefined>();
  private readonly visibleEditorsEmitter = new EventEmitter<readonly TextEditor[]>();
  private readonly selectionEmitter = new EventEmitter<{
    textEditor: TextEditor;
    selections: readonly Selection[];
    kind?: TextEditorSelectionChangeKind;
  }>();
  private readonly visibleRangesEmitter = new EventEmitter<{
    textEditor: TextEditor;
    visibleRanges: readonly Range[];
  }>();
  private readonly decorationTypes = new Map<string, DecorationRenderOptions>();
  private readonly optionsEmitter = new EventEmitter<{
    textEditor: TextEditor;
    options: ResolvedTextEditorOptions;
  }>();
  private readonly pendingEditors = new Set<(error: Error) => void>();
  private decorationCounter = 0;
  private lastActiveTabGroupId: string | undefined;
  private readonly stateValue = shallowRef<WindowState>(
    Object.freeze({
      focused: typeof document !== "undefined" && document.hasFocus(),
      active: typeof document !== "undefined",
    }),
  );
  private readonly stateEmitter = new EventEmitter<WindowState>();
  readonly windowState = computed(() => this.stateValue.value);
  readonly onDidChangeWindowState = this.stateEmitter.event;
  readonly tabGroups = new TabGroupsData((kind, ids, preserveFocus) =>
    kind === "tabs" ? this.closeTabs(ids, preserveFocus) : this.closeTabGroups(ids, preserveFocus),
  );
  readonly tabGroupsSnapshot = computed<TabGroupsSnapshot>(() => {
    const groups = this.tabs.groups.value.filter(
      (group) => group.tabIds.length > 0 || !group.hasForeignPanels,
    );
    const active =
      groups.find((group) => group.isActive) ??
      groups.find((group) => group.id === this.lastActiveTabGroupId) ??
      groups[0];
    if (active) this.lastActiveTabGroupId = active.id;
    return {
      groups: groups.map((group, index) => ({
        id: group.id,
        viewColumn: index + 1,
        isActive: group === active,
        tabs: group.tabIds.flatMap((id) => {
          const tab = this.tabs.get(id);
          if (!tab) return [];
          const doc =
            tab.descriptor instanceof FileEditorTabDescriptor
              ? this.editorService.getDocumentById(tab.descriptor.documentId)
              : undefined;
          return [
            {
              id,
              label: doc?.name ?? tab.title,
              input:
                tab.descriptor instanceof VirtualTextEditorTab
                  ? { kind: "text" as const, uri: tab.descriptor.resource }
                  : doc
                    ? { kind: "text" as const, uri: Uri.file(doc.path).toJSON() }
                    : { kind: "unknown" as const },
              isActive: group.activeTabId === id,
              isDirty: doc ? this.editorService.isDirty(doc) : tab.dirty,
              isPinned: group.pinnedTabIds.includes(id),
              isPreview: doc !== undefined && this.editorService.previewPath.value === doc.path,
            },
          ];
        }),
      })),
    };
  });
  readonly onDidChangeActiveTextEditor = this.activeEditorEmitter.event;
  readonly onDidChangeVisibleTextEditors = this.visibleEditorsEmitter.event;
  readonly onDidChangeTextEditorSelection = this.selectionEmitter.event;
  readonly onDidChangeTextEditorOptions = this.optionsEmitter.event;
  readonly onDidChangeTextEditorVisibleRanges = this.visibleRangesEmitter.event;
  readonly visibleTextEditors: ComputedRef<readonly TextEditor[]> = computed(() => [
    ...this.editorInstances.values(),
  ]);
  readonly activeTextEditor: ComputedRef<TextEditor | undefined> = computed(() =>
    this.activeDocument.value ? this.editorInstances.get(this.activeDocument.value) : undefined,
  );

  constructor() {
    watch(this.tabGroupsSnapshot, (snapshot) => this.tabGroups.update(snapshot), {
      immediate: true,
      flush: "sync",
    });
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      const update = (patch: Partial<WindowState>) => {
        const next = Object.freeze({ ...this.stateValue.value, ...patch });
        if (
          next.focused === this.stateValue.value.focused &&
          next.active === this.stateValue.value.active
        )
          return;
        this.stateValue.value = next;
        this.stateEmitter.fire(next);
      };
      const focus = () => update({ focused: document.hasFocus() });
      let idleIntervals = 0;
      let inactiveTimer: ReturnType<typeof setTimeout> | undefined;
      const activity = () => {
        idleIntervals = 0;
        if (inactiveTimer) clearTimeout(inactiveTimer);
        inactiveTimer = undefined;
        update({ active: true });
      };
      const interval = setInterval(() => {
        if (++idleIntervals === 2)
          inactiveTimer = setTimeout(() => update({ active: false }), 10_000);
      }, 30_000);
      window.addEventListener("focus", focus);
      window.addEventListener("blur", focus);
      for (const event of ["touchstart", "mousedown", "keydown"])
        document.addEventListener(event, activity, { capture: true, passive: true });
      onScopeDispose(() => {
        clearInterval(interval);
        if (inactiveTimer) clearTimeout(inactiveTimer);
        window.removeEventListener("focus", focus);
        window.removeEventListener("blur", focus);
        for (const event of ["touchstart", "mousedown", "keydown"])
          document.removeEventListener(event, activity, true);
      });
    }
    onScopeDispose(() => {
      for (const reject of this.pendingEditors) reject(new Error("Editor service disposed"));
      this.pendingEditors.clear();
      this.activeEditorEmitter.dispose();
      this.visibleEditorsEmitter.dispose();
      this.selectionEmitter.dispose();
      this.visibleRangesEmitter.dispose();
      this.optionsEmitter.dispose();
      this.stateEmitter.dispose();
      this.tabGroups.dispose();
    });
  }

  private workspaceFileEditors(): Map<string, TextDocument> {
    const documents = new Map<string, TextDocument>();
    for (const { descriptor } of this.tabs.tabs.values()) {
      if (!(descriptor instanceof FileEditorTabDescriptor)) continue;
      const file = this.editorService.getDocumentById(descriptor.documentId);
      if (!file || file.binary || file.tooLarge) continue;
      const uri = Uri.file(file.path);
      const key = uri.toString();
      if (documents.has(key) || !this.workspaceCompat.getWorkspaceFolder(uri)) continue;
      const document = this.workspaceCompat.getTextDocument(file.path);
      if (document) documents.set(key, document);
    }
    return documents;
  }

  async saveFileEditor(uri: Uri): Promise<Uri | undefined> {
    if (uri.scheme !== "file") return undefined;
    const document = this.workspaceFileEditors().get(uri.toString());
    if (await document?.save()) return uri;
    return undefined;
  }

  async saveAllFileEditors(): Promise<boolean> {
    const dirty = [...this.workspaceFileEditors().values()].filter((document) => document.isDirty);
    const saved = await Promise.all(dirty.map((document) => document.save()));
    return saved.every(Boolean);
  }

  async closeTabs(ids: readonly string[], preserveFocus = false): Promise<boolean> {
    const activeGroup = this.tabGroupsSnapshot.value.groups.find((group) => group.isActive)?.id;
    let allClosed = true;
    for (const id of ids) {
      const tab = this.tabs.get(id);
      if (!tab) {
        allClosed = false;
        continue;
      }
      const doc =
        tab.descriptor instanceof FileEditorTabDescriptor
          ? this.editorService.getDocumentById(tab.descriptor.documentId)
          : undefined;
      const dirty = doc ? this.editorService.isDirty(doc) : tab.dirty;
      const hasOtherView =
        doc !== undefined &&
        [...this.tabs.tabs.values()].some(
          (item) =>
            item !== tab &&
            item.descriptor instanceof FileEditorTabDescriptor &&
            item.descriptor.documentId === doc.id,
        );
      if (dirty && !hasOtherView) {
        if (
          typeof window === "undefined" ||
          !window.confirm(`Discard unsaved changes in ${doc?.name ?? tab.descriptor.defaultTitle}?`)
        ) {
          allClosed = false;
          continue;
        }
      }
      this.tabs.close(id);
      if (dirty && doc && !hasOtherView) this.editorService.closeDocument(doc.path);
      if (this.tabs.get(id)) allClosed = false;
    }
    if (preserveFocus && activeGroup) this.tabs.focusGroup(activeGroup);
    return allClosed;
  }

  async closeTabGroups(ids: readonly string[], preserveFocus = false): Promise<boolean> {
    const activeGroup = this.tabGroupsSnapshot.value.groups.find((group) => group.isActive)?.id;
    let allClosed = true;
    for (const id of ids) {
      const group = this.tabs.groups.value.find((candidate) => candidate.id === id);
      if (!group) {
        allClosed = false;
        continue;
      }
      if (!(await this.closeTabs(group.tabIds, preserveFocus))) {
        allClosed = false;
        continue;
      }
      if (!group.hasForeignPanels) this.tabs.closeGroup(id);
    }
    if (preserveFocus && activeGroup) this.tabs.focusGroup(activeGroup);
    return allClosed;
  }

  registerMonacoEditor(path: string, editor: monaco.editor.IStandaloneCodeEditor): () => void {
    const source = this.editorService.getDocument(path);
    if (!source) throw new Error(`No text document for editor: ${path}`);
    const document = computed(
      () =>
        this.workspaceCompat.getTextDocument(source.path) ??
        new TextDocument(source, this.editorService),
    );
    const model = editor.getModel();
    const forgetModel = model ? associateFileModel(model, () => Uri.file(source.path)) : undefined;
    const mounted = this.attachEditor(source, document, editor);
    const stopPathWatch = watch(
      () => source.path,
      () => {
        if (this.editorInstances.get(source) !== mounted.editor) return;
        this.visibleEditorsEmitter.fire(this.visibleTextEditors.value);
        if (this.activeDocument.value === source) this.activeEditorEmitter.fire(mounted.editor);
      },
      { flush: "post" },
    );
    return () => {
      stopPathWatch();
      forgetModel?.();
      mounted.dispose();
    };
  }

  private attachEditor(
    source: EditorDocument | TextDocumentData,
    document: TextDocumentData | ComputedRef<TextDocumentData>,
    editor: monaco.editor.IStandaloneCodeEditor,
  ) {
    const wrapped = new TextEditor(document, editor, (key) => this.decorationTypes.get(key));
    this.editorInstances.set(source, wrapped);
    this.visibleEditorsEmitter.fire(this.visibleTextEditors.value);
    const activate = () => {
      if (this.activeDocument.value === source) return;
      this.activeDocument.value = source;
      this.activeEditorEmitter.fire(wrapped);
    };
    activate();
    const focus = editor.onDidFocusEditorText(activate);
    const editorOptions = observeEditorOptions(editor, (options) => {
      this.optionsEmitter.fire({ textEditor: wrapped, options });
    });
    let previousSelections = editor.getSelections() ?? [];
    const selection = editor.onDidChangeCursorSelection((event) => {
      const selections = [event.selection, ...event.secondarySelections];
      if (monaco.Selection.selectionsArrEqual(previousSelections, selections)) return;
      previousSelections = selections;
      this.selectionEmitter.fire({
        textEditor: wrapped,
        selections: selections.map(fromMonacoSelection),
        kind: selectionChangeKind(event.source),
      });
    });
    let previousRanges = JSON.stringify(wrapped.visibleRanges);
    const updateVisibleRanges = () => {
      const visibleRanges = wrapped.visibleRanges;
      const key = JSON.stringify(visibleRanges);
      if (key === previousRanges) return;
      previousRanges = key;
      this.visibleRangesEmitter.fire({ textEditor: wrapped, visibleRanges });
    };
    const scroll = editor.onDidScrollChange(updateVisibleRanges);
    const layout = editor.onDidLayoutChange(updateVisibleRanges);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      focus.dispose();
      selection.dispose();
      editorOptions.dispose();
      scroll.dispose();
      layout.dispose();
      if (this.editorInstances.get(source) !== wrapped) return;
      this.editorInstances.delete(source);
      this.visibleEditorsEmitter.fire(this.visibleTextEditors.value);
      if (this.activeDocument.value === source) {
        this.activeDocument.value = null;
        this.activeEditorEmitter.fire(undefined);
      }
    };
    return { editor: wrapped, dispose };
  }

  async showVirtualTextDocument(
    owner: string,
    documentId: string,
    snapshot: TextDocumentSnapshot,
    options: TextDocumentShowOptions | number,
    preserveFocus: boolean,
    onClose: () => void,
  ): Promise<TextEditor> {
    const showOptions = typeof options === "number" ? { preserveFocus } : options;
    const editor = await this.virtualTabs.show(
      owner,
      documentId,
      snapshot,
      onClose,
      showOptions.label,
    );
    return this.revealEditor(editor, showOptions);
  }

  updateVirtualTextDocument(
    owner: string,
    documentId: string,
    snapshot: TextDocumentSnapshot,
  ): void {
    this.virtualTabs.update(owner, documentId, snapshot);
  }

  closeVirtualTextDocuments(owner: string, documentId?: string): void {
    this.virtualTabs.close(owner, documentId);
  }

  async showTextDocument(
    documentOrUri: TextDocument | Uri,
    options: TextDocumentShowOptions | number = {},
    preserveFocus = false,
  ): Promise<TextEditor> {
    const document =
      documentOrUri instanceof TextDocument
        ? documentOrUri
        : await this.workspaceCompat.openTextDocument(documentOrUri);
    const showOptions =
      typeof options === "number" ? { viewColumn: options, preserveFocus } : options;
    const source = this.editorService.getDocument(document.fileName);
    if (!source) throw new Error(`Cannot show text document: ${document.uri.toString()}`);
    const existing = this.editorInstances.get(source);
    let rejectOpen: ((error: Error) => void) | undefined;
    const ready = existing
      ? Promise.resolve(existing)
      : new Promise<TextEditor>((resolve, reject) => {
          const fail = (error: Error) => {
            subscription.dispose();
            this.pendingEditors.delete(fail);
            reject(error);
          };
          const subscription = this.onDidChangeVisibleTextEditors(() => {
            const opened = this.editorInstances.get(source);
            if (opened) {
              subscription.dispose();
              this.pendingEditors.delete(fail);
              resolve(opened);
            }
          });
          this.pendingEditors.add(fail);
          rejectOpen = fail;
        });
    const opening = openFileEditorTab(this.tabs, this.editorService, {
      root: source.root,
      relativePath: source.relativePath,
      preview: showOptions.preview,
    }).catch((error) => {
      rejectOpen?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    const [, editor] = await Promise.all([opening, ready]);
    return this.revealEditor(editor, showOptions);
  }

  private revealEditor(editor: TextEditor, showOptions: TextDocumentShowOptions): TextEditor {
    if (showOptions.selection) {
      editor.selection = new Selection(showOptions.selection.start, showOptions.selection.end);
      editor.revealRange(showOptions.selection);
    }
    if (!showOptions.preserveFocus) editor.focus();
    return editor;
  }

  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType {
    const key = `vscode-compat-dec-${++this.decorationCounter}`;
    this.decorationTypes.set(key, options);
    const style = typeof document === "undefined" ? undefined : document.createElement("style");
    const css = (value: DecorationRenderOptions) => {
      const properties = {
        color: "color",
        backgroundColor: "background-color",
        border: "border",
        borderColor: "border-color",
        borderWidth: "border-width",
        borderStyle: "border-style",
        borderRadius: "border-radius",
        fontStyle: "font-style",
        fontWeight: "font-weight",
        textDecoration: "text-decoration",
        cursor: "cursor",
        opacity: "opacity",
      } as const;
      return Object.entries(properties)
        .flatMap(([name, property]) => {
          const raw = value[name as keyof typeof properties];
          return raw === undefined
            ? []
            : [
                `${property}:${typeof raw === "object" ? `var(--vscode-${raw.id.replaceAll(".", "-")})` : raw}`,
              ];
        })
        .join(";");
    };
    if (style) {
      style.textContent = `.${key}{${css(options)}}.monaco-editor.vs .${key}{${css(options.light ?? {})}}.monaco-editor.vs-dark .${key}{${css(options.dark ?? {})}}`;
      document.head.appendChild(style);
    }
    return {
      key,
      dispose: () => {
        if (!this.decorationTypes.delete(key)) return;
        for (const editor of this.editorInstances.values()) editor.clearDecoration(key);
        style?.remove();
      },
    };
  }
}
