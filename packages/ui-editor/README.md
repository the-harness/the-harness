```ts
interface EditorDocument {
  readonly id: number; // Stable while the working copy is open.
  readonly path: string;
  readonly root: string;
  readonly relativePath: string;
  readonly name: string;
  language: string; // Refreshes from installed language contributions and the first line.
  content: string;
  savedContent: string;
  mtimeMs: number;
  size: number;
  loading: boolean;
  binary: boolean;
  tooLarge: boolean;
  externalDeleted: boolean;
  externalChanged: boolean;
  error?: string;
}

function ensureMonacoWorkers(): void; // Initializes Monaco workers for browser editors.

function inferLanguage(filePath: string, firstLine?: string): string;

type ModelEditListener = (
  document: EditorDocument,
  previousContent: string,
  event: editor.IModelContentChangedEvent,
) => void;

class FileEditorService {
  readonly documents: ReadonlyMap<string, EditorDocument>;
  readonly previewPath: Ref<string | null>;
  openDocument(
    root: string,
    relativePath: string,
    options?: { preview?: boolean },
  ): Promise<EditorDocument>;
  getDocument(path: string): EditorDocument | undefined;
  getDocumentById(id: number): EditorDocument | undefined;
  getEditorView(tabId: string): editor.IStandaloneCodeEditor | undefined; // Exact mounted view, including split editors.
  getDocumentSymbols(tabId: string): Promise<languages.DocumentSymbol[]>; // Uses installed Monaco language providers.
  notifyEditorMounted(path: string, editor: editor.IStandaloneCodeEditor, tabId: string): () => void; // Registers a view and notifies editor hooks; dispose on unmount.
  isDirty(pathOrDocument: string | EditorDocument): boolean;
  onDidEditContent(listener: ModelEditListener): () => void; // Fires after a model edit updates the working copy.
  updateContent(path: string, content: string, event?: editor.IModelContentChangedEvent): void; // Pins the preview. Pass an event only if it applies to the previous content.
  pinDocument(path: string): void;
  saveDocument(path: string): Promise<void>;
  renameDocument(root: string, oldRelativePath: string, newRelativePath: string): Promise<void>; // Moves a working copy after the file is renamed.
  reloadDocument(path: string): Promise<void>;
  closeDocument(path: string): void;
}

class FileEditorTabDescriptor extends TabDescriptor {
  readonly documentId: number;
  readonly name: string;
  constructor(input?: { documentId: number; name: string; pinned?: boolean });
  readonly key: string;
  readonly defaultTitle: string;
}

function openFileEditorTab(
  tabs: UiTabsService,
  editor: FileEditorService,
  input: { root: string; relativePath: string; preview?: boolean },
): Promise<void>; // Opens a view of the stable working copy.
```
