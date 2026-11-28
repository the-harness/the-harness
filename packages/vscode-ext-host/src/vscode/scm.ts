import type { ExtHostBridge } from "./bridge.ts";
import { EventEmitter, Position, Range, Uri } from "./types.ts";
import { reviveTextDocument } from "./document.ts";

type Command = { command: string; title?: string; tooltip?: string; arguments?: unknown[] };
type ResourceState = {
  resourceUri: Uri;
  command?: Command;
  decorations?: unknown;
  contextValue?: string;
};
let scmCounter = 0;

export function createScmNamespace(
  bridge: ExtHostBridge,
  executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>,
) {
  const sources = new Map<
    string,
    { updateInput(value: string): void; select(value: boolean): void; inputBox: unknown }
  >();
  const identities = new WeakMap<object, { handle: string; disposed: EventEmitter<void> }>();
  bridge.commandHandlers.set("__scm.inputChanged", (handle, value) =>
    sources.get(String(handle))?.updateInput(String(value)),
  );
  bridge.commandHandlers.set("__scm.selectionChanged", (handle, value) =>
    sources.get(String(handle))?.select(Boolean(value)),
  );
  return {
    get inputBox() {
      return [...sources.values()].at(-1)?.inputBox;
    },
    createSourceControl(
      id: string,
      label: string,
      rootUri?: Uri,
      iconPath?: unknown,
      parent?: object,
    ) {
      const parentState = parent ? identities.get(parent) : undefined;
      if (parent && !parentState)
        throw new Error("Source control parent was not created by this extension host");
      const handle = `scm-${++scmCounter}`;
      const disposal = new EventEmitter<void>();
      const parentDisposal = new EventEmitter<void>();
      const parentSubscription = parentState?.disposed.event(() => parentDisposal.fire());
      const selection = new EventEmitter<boolean>();
      const inputChange = new EventEmitter<string>();
      const commands = new Map<string, Command>();
      let nextResourceCommand = 0;
      const groups = new Map<string, { dispose(): void }>();
      const inputUri = Uri.from({ scheme: "vscode-scm", path: `/${handle}/input` });
      const inputSnapshot = {
        uri: inputUri.toJSON(),
        text: "",
        version: 1,
        languageId: "scminput",
        isDirty: false,
        eol: 1 as const,
      };
      bridge.commandHandlers.get("__ws.onDidOpenTextDocument")?.(inputSnapshot);
      const inputDocument = reviveTextDocument(bridge, inputSnapshot);
      let disposed = false;
      let selected = false;
      let value = "";
      let placeholder = "";
      let enabled = true;
      let visible = true;
      let acceptInputCommand: Command | undefined;
      let count: number | undefined;
      let commitTemplate: string | undefined;
      let statusBarCommands: Command[] | undefined;
      let contextValue: string | undefined;
      let activeRepositoryName: string | undefined;
      const convertCommand = (slot: string, command: Command | undefined, resource = false) => {
        const name = `__scm.command.${handle}.${slot}`;
        if (!command) {
          if (commands.delete(slot)) {
            bridge.commandHandlers.delete(name);
            void bridge.callMain("commands.unregister", name);
          }
          return undefined;
        }
        if (!commands.has(slot)) {
          bridge.commandHandlers.set(name, () => {
            const { command, arguments: args = [] } = commands.get(slot)!;
            const openEditor = ["vscode.open", "vscode.diff", "vscode.changes"].includes(command);
            return executeCommand(command, ...args, ...(resource && !openEditor ? [false] : []));
          });
          void bridge.callMain("commands.register", name);
        }
        commands.set(slot, command);
        return { command: name, title: command.title, tooltip: command.tooltip };
      };
      const updateInput = (next: string) => {
        if (value === next) return;
        const previous = value;
        const end = inputDocument.positionAt(previous.length);
        value = next;
        const snapshot = {
          ...inputDocument.toJSON(),
          text: value,
          version: inputDocument.version + 1,
        };
        bridge.commandHandlers.get("__ws.onDidChangeTextDocument")?.({
          document: snapshot,
          contentChanges: [
            {
              range: new Range(new Position(0, 0), end),
              rangeOffset: 0,
              rangeLength: previous.length,
              text: value,
            },
          ],
        });
        inputChange.fire(value);
      };
      const inputBox = {
        get value() {
          return value;
        },
        set value(next: string) {
          updateInput(next);
          void bridge.callMain("scm.inputBox", handle, { value });
        },
        get placeholder() {
          return placeholder;
        },
        set placeholder(next: string) {
          placeholder = next;
          void bridge.callMain("scm.inputBox", handle, { placeholder });
        },
        get enabled() {
          return enabled;
        },
        set enabled(next: boolean) {
          enabled = next;
          void bridge.callMain("scm.inputBox", handle, { enabled });
        },
        get visible() {
          return visible;
        },
        set visible(next: boolean) {
          visible = next;
          void bridge.callMain("scm.inputBox", handle, { visible });
        },
        document: inputDocument,
        onDidChange: inputChange.event,
      };
      sources.set(handle, {
        inputBox,
        updateInput,
        select(next) {
          if (selected !== next) {
            selected = next;
            selection.fire(next);
          }
        },
      });
      void bridge.callMain("scm.create", handle, id, label, rootUri?.fsPath, {
        iconPath,
        parent: parentState?.handle,
      });
      const source = {
        id,
        label,
        rootUri,
        inputBox,
        onDidDisposeParent: parentDisposal.event,
        get contextValue() {
          return contextValue;
        },
        set contextValue(next: string | undefined) {
          contextValue = next;
          void bridge.callMain("scm.updateProvider", handle, { contextValue: next ?? null });
        },
        get activeRepositoryName() {
          return activeRepositoryName;
        },
        set activeRepositoryName(next: string | undefined) {
          activeRepositoryName = next;
          void bridge.callMain("scm.updateProvider", handle, {
            activeRepositoryName: next ?? null,
          });
        },
        get selected() {
          return selected;
        },
        onDidChangeSelection: selection.event,
        get count() {
          return count;
        },
        set count(next: number | undefined) {
          count = next;
          void bridge.callMain("scm.updateProvider", handle, { count: next ?? null });
        },
        get commitTemplate() {
          return commitTemplate;
        },
        set commitTemplate(next: string | undefined) {
          commitTemplate = next;
          void bridge.callMain("scm.updateProvider", handle, { commitTemplate: next ?? null });
        },
        get acceptInputCommand() {
          return acceptInputCommand;
        },
        set acceptInputCommand(next: Command | undefined) {
          acceptInputCommand = next;
          void bridge.callMain("scm.acceptInputCommand", handle, convertCommand("accept", next));
        },
        get statusBarCommands() {
          return statusBarCommands;
        },
        set statusBarCommands(next: Command[] | undefined) {
          for (const slot of commands.keys())
            if (slot.startsWith("status.")) convertCommand(slot, undefined);
          statusBarCommands = next;
          void bridge.callMain("scm.updateProvider", handle, {
            statusBarCommands:
              next?.map((command, index) => convertCommand(`status.${index}`, command)) ?? [],
          });
        },
        createResourceGroup(groupId: string, groupLabel: string) {
          groups.get(groupId)?.dispose();
          void bridge.callMain("scm.createGroup", handle, groupId, groupLabel);
          let states: ResourceState[] = [];
          let currentLabel = groupLabel;
          let hideWhenEmpty = false;
          let groupDisposed = false;
          const resourceCommands: string[] = [];
          const clearResourceCommands = () => {
            for (const slot of resourceCommands.splice(0)) convertCommand(slot, undefined);
          };
          const group = {
            id: groupId,
            get label() {
              return currentLabel;
            },
            set label(next: string) {
              currentLabel = next;
              void bridge.callMain("scm.updateGroup", handle, groupId, { label: next });
            },
            get hideWhenEmpty() {
              return hideWhenEmpty;
            },
            set hideWhenEmpty(next: boolean) {
              hideWhenEmpty = next;
              void bridge.callMain("scm.updateGroup", handle, groupId, { hideWhenEmpty: next });
            },
            get resourceStates() {
              return states;
            },
            set resourceStates(next: ResourceState[]) {
              if (groupDisposed) return;
              clearResourceCommands();
              states = next.slice();
              const resources = states.map((state) => {
                const slot = `resource.${++nextResourceCommand}`;
                const command = convertCommand(slot, state.command, true);
                if (command) resourceCommands.push(slot);
                return {
                  resourceUri: state.resourceUri.toJSON(),
                  command,
                  decorations: state.decorations,
                  contextValue: state.contextValue,
                };
              });
              void bridge.callMain("scm.setResources", handle, groupId, resources);
            },
            dispose() {
              if (groupDisposed) return;
              groupDisposed = true;
              clearResourceCommands();
              groups.delete(groupId);
              void bridge.callMain("scm.disposeGroup", handle, groupId);
            },
          };
          groups.set(groupId, group);
          return group;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          disposal.fire();
          disposal.dispose();
          parentSubscription?.dispose();
          parentDisposal.dispose();
          identities.delete(source);
          for (const group of groups.values()) group.dispose();
          for (const slot of commands.keys()) convertCommand(slot, undefined);
          sources.delete(handle);
          selection.dispose();
          inputChange.dispose();
          bridge.commandHandlers.get("__ws.onDidCloseTextDocument")?.(inputDocument.toJSON());
          void bridge.callMain("scm.dispose", handle);
        },
      };
      identities.set(source, { handle, disposed: disposal });
      return source;
    },
  };
}
