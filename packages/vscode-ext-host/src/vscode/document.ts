import {
  TextDocumentData,
  Uri,
  type Position,
  type TextDocumentSnapshot,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

const documents = new WeakMap<ExtHostBridge, Map<string, TextDocumentData>>();
const wordPatterns = new WeakMap<ExtHostBridge, Map<string, Set<RegExp>>>();

export function registerWordPattern(
  bridge: ExtHostBridge,
  languageId: string,
  pattern: RegExp,
): () => void {
  let byLanguage = wordPatterns.get(bridge);
  if (!byLanguage) wordPatterns.set(bridge, (byLanguage = new Map()));
  let patterns = byLanguage.get(languageId);
  if (!patterns) byLanguage.set(languageId, (patterns = new Set()));
  const registered = new RegExp(pattern.source, pattern.flags);
  patterns.add(registered);
  return () => {
    if (patterns.delete(registered) && !patterns.size) byLanguage.delete(languageId);
  };
}

class ExtensionTextDocument extends TextDocumentData {
  private readonly bridge: ExtHostBridge;

  constructor(
    snapshot: TextDocumentSnapshot,
    bridge: ExtHostBridge,
    save?: () => Promise<boolean>,
  ) {
    super(snapshot, save);
    this.bridge = bridge;
  }

  override getWordRangeAtPosition(position: Position, regex?: RegExp) {
    const patterns = wordPatterns.get(this.bridge)?.get(this.languageId);
    return super.getWordRangeAtPosition(position, regex ?? (patterns && [...patterns].at(-1)));
  }
}

export const virtualDocumentViewIds = new WeakMap<TextDocumentData, string>();

export function getTextDocuments(bridge: ExtHostBridge): Map<string, TextDocumentData> {
  let store = documents.get(bridge);
  if (!store) {
    store = new Map();
    documents.set(bridge, store);
  }
  return store;
}

export function reviveTextDocument(
  bridge: ExtHostBridge,
  snapshot: TextDocumentSnapshot,
): TextDocumentData {
  const uri = Uri.from(snapshot.uri);
  const store = getTextDocuments(bridge);
  let document = store.get(uri.toString());
  if (!document) {
    const save =
      uri.scheme === "file"
        ? async () => Boolean(await bridge.callMain("workspace.saveTextDocument", uri.toJSON()))
        : undefined;
    document = new ExtensionTextDocument(snapshot, bridge, save);
    store.set(uri.toString(), document);
  } else if (snapshot.version >= document.version) {
    document.update(snapshot);
  }
  return document;
}
