import { useService } from "@harness/ui-di";
import { ensureMonacoWorkers } from "@harness/ui-editor";
import {
  TabContext,
  TabDescriptor,
  UiWorkbenchService,
  type UiTabsService,
} from "@harness/ui-workbench";
import { variant } from "@harness/variants";
import { TextDocumentData, Uri, type TextDocumentSnapshot } from "@harness/vscode-types";
import * as monaco from "monaco-editor";
import { defineComponent, h, onBeforeUnmount, onMounted, onScopeDispose, ref, watch } from "vue";
import { activeContributions } from "./contribution-state.ts";
import type { TextEditor } from "./window.ts";

@variant("harness:vscode:virtual-text-editor")
export class VirtualTextEditorTab extends TabDescriptor {
  declare readonly label?: string;
  declare readonly owner: string;
  declare readonly documentId: string;
  declare readonly resource: TextDocumentSnapshot["uri"];

  constructor(input?: {
    label?: string;
    owner: string;
    documentId: string;
    resource: TextDocumentSnapshot["uri"];
  }) {
    super(input);
  }

  get key(): string {
    return virtualTabKey(this.owner, this.documentId);
  }

  get defaultTitle(): string {
    return (
      this.label ??
      this.resource.path?.split("/").filter(Boolean).at(-1) ??
      Uri.from(this.resource).toString()
    );
  }
}

type Entry = {
  readonly document: TextDocumentData;
  readonly model: monaco.editor.ITextModel;
  editor?: TextEditor;
  ready?: PromiseWithResolvers<TextEditor>;
};

function virtualTabKey(owner: string, documentId: string): string {
  return `virtual:${JSON.stringify([owner, documentId])}`;
}

export class VirtualTextEditorTabs {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly tabs: UiTabsService,
    attach: (
      document: TextDocumentData,
      editor: monaco.editor.IStandaloneCodeEditor,
    ) => { editor: TextEditor; dispose(): void },
  ) {
    const entries = this.entries;
    tabs.useRenderer({
      descriptor: VirtualTextEditorTab,
      icon: "i-codicon-lock",
      component: defineComponent({
        setup() {
          const { descriptor } = useService(TabContext) as TabContext<VirtualTextEditorTab>;
          const workbench = useService(UiWorkbenchService);
          const theme = () =>
            activeContributions.value?.themeName ??
            (workbench.theme.value === "dark" ? "vs-dark" : "vs");
          const container = ref<HTMLElement>();
          let editor: monaco.editor.IStandaloneCodeEditor | undefined;
          let dispose: (() => void) | undefined;
          const entry = entries.get(descriptor.key);
          onMounted(() => {
            if (!entry || !container.value) return;
            editor = monaco.editor.create(container.value, {
              model: entry.model,
              readOnly: true,
              automaticLayout: true,
              theme: theme(),
              minimap: { enabled: false },
            });
            const mounted = attach(entry.document, editor);
            dispose = mounted.dispose;
            entry.editor = mounted.editor;
            entry.ready?.resolve(mounted.editor);
            entry.ready = undefined;
          });
          watch(theme, (value) => monaco.editor.setTheme(value));
          onBeforeUnmount(() => {
            if (entry) entry.editor = undefined;
            dispose?.();
            editor?.dispose();
          });
          return () =>
            h("div", {
              ref: container,
              class: "virtual-text-editor",
              style: { width: "100%", height: "100%" },
            });
        },
      }),
    });
  }

  show(
    owner: string,
    documentId: string,
    snapshot: TextDocumentSnapshot,
    onClose: () => void,
    label?: string,
  ) {
    const descriptor = new VirtualTextEditorTab({
      owner,
      documentId,
      resource: snapshot.uri,
      label,
    });
    const existing = this.entries.get(descriptor.key);
    if (existing) {
      this.update(owner, documentId, snapshot);
      const tab = this.tabs.open(descriptor);
      if (label) tab.title = label;
      if (existing.editor) return Promise.resolve(existing.editor);
      return (existing.ready ??= Promise.withResolvers<TextEditor>()).promise;
    }
    ensureMonacoWorkers();
    const ready = Promise.withResolvers<TextEditor>();
    const entry: Entry = {
      document: new TextDocumentData(snapshot),
      model: monaco.editor.createModel(
        snapshot.text,
        snapshot.languageId,
        monaco.Uri.from(snapshot.uri),
      ),
      ready,
    };
    this.entries.set(descriptor.key, entry);
    const release = () => {
      this.entries.delete(descriptor.key);
      entry.document.update({ ...entry.document.toJSON(), isClosed: true });
      entry.model.dispose();
      entry.ready?.reject(new Error("Virtual document closed before its editor opened"));
    };
    try {
      const tab = this.tabs.open(descriptor);
      tab.scope.run(() =>
        onScopeDispose(() => {
          release();
          onClose();
        }),
      );
    } catch (error) {
      release();
      void ready.promise.catch(() => undefined);
      throw error;
    }
    return ready.promise;
  }

  update(owner: string, documentId: string, snapshot: TextDocumentSnapshot): void {
    const entry = this.entries.get(virtualTabKey(owner, documentId));
    if (!entry || entry.document.version >= snapshot.version) return;
    entry.document.update(snapshot);
    if (entry.model.getValue() !== snapshot.text) entry.model.setValue(snapshot.text);
  }

  close(owner: string, documentId?: string): void {
    for (const tab of this.tabs.tabs.values()) {
      const descriptor = tab.descriptor;
      if (
        descriptor instanceof VirtualTextEditorTab &&
        descriptor.owner === owner &&
        (documentId === undefined || descriptor.documentId === documentId)
      )
        this.tabs.close(tab.tabId);
    }
  }
}
