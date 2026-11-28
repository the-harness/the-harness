import { type EditorDocument, type FileEditorService } from "@harness/ui-editor";
import { TabDescriptor, type TabInstance, type UiTabsService } from "@harness/ui-workbench";
import { variant } from "@harness/variants";
import { onScopeDispose, watch } from "vue";

@variant("harness:web:file-editor")
export class FileEditorTabDescriptor extends TabDescriptor {
  static override readonly kind = "file-editor";
  declare readonly documentId: number;
  declare readonly name: string;

  constructor(input?: { documentId: number; name: string; pinned?: boolean }) {
    super(input);
  }

  get key(): string {
    return `file:${this.documentId}`;
  }

  get defaultTitle(): string {
    return this.name;
  }
}

export async function openFileEditorTab(
  tabs: UiTabsService,
  editor: FileEditorService,
  input: { root: string; relativePath: string; preview?: boolean },
): Promise<void> {
  const opening = editor.openDocument(input.root, input.relativePath, { preview: input.preview });
  const root = input.root.replace(/\/+$/, "");
  const relativePath = input.relativePath.replace(/^\/+/, "");
  const path = relativePath ? `${root}/${relativePath}` : root;
  const doc = editor.getDocument(path) ?? (await opening);
  const tab = tabs.open(
    new FileEditorTabDescriptor({
      documentId: doc.id,
      name: doc.name,
      pinned: input.preview === false,
    }),
  );
  bindFileEditorTab(tabs, editor, tab, doc);
}

export function bindFileEditorTab(
  tabs: UiTabsService,
  editor: FileEditorService,
  tab: TabInstance<FileEditorTabDescriptor>,
  doc: EditorDocument,
): void {
  tabs.runOnce(tab, "file-editor", () => {
    watch(
      () => [editor.isDirty(doc), doc.name] as const,
      ([dirty, name]) => {
        tab.title = dirty ? `● ${name}` : name;
      },
      { immediate: true },
    );
    onScopeDispose(() => {
      if (editor.getDocument(doc.path) === doc && !editor.isDirty(doc)) {
        const hasOtherView = [...tabs.tabs.values()].some(
          (item) =>
            item !== tab &&
            item.descriptor instanceof FileEditorTabDescriptor &&
            item.descriptor.documentId === doc.id,
        );
        if (!hasOtherView) editor.closeDocument(doc.path);
      }
    });
  });
}
