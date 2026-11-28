import {
  CancellationTokenSource,
  Disposable,
  Position,
  TypeHierarchyItem,
  Uri,
  type CancellationToken,
  type TextDocumentData,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";
import type { DocumentSelector } from "./languages.ts";

type ProviderResult<T> = T | undefined | null | PromiseLike<T | undefined | null>;

// Extensions supply type hierarchy roots and expand the items they previously returned.
interface TypeHierarchyProvider {
  prepareTypeHierarchy(
    document: TextDocumentData,
    position: Position,
    token: CancellationToken,
  ): ProviderResult<TypeHierarchyItem | TypeHierarchyItem[]>;
  provideTypeHierarchySupertypes(
    item: TypeHierarchyItem,
    token: CancellationToken,
  ): ProviderResult<TypeHierarchyItem[]>;
  provideTypeHierarchySubtypes(
    item: TypeHierarchyItem,
    token: CancellationToken,
  ): ProviderResult<TypeHierarchyItem[]>;
}

type Registration = { selector: DocumentSelector; provider: TypeHierarchyProvider };
type Session = { registration: Registration; items: Map<string, TypeHierarchyItem> };

export function createTypeHierarchyApi(
  bridge: ExtHostBridge,
  openTextDocument: (uri: Uri) => Promise<TextDocumentData>,
  match: (selector: DocumentSelector, document: TextDocumentData) => number,
) {
  const registrations = new Set<Registration>();
  const sessions = new Map<string, Session>();
  let nextSessionId = 0;

  async function withToken<T>(run: (token: CancellationToken) => Promise<T>): Promise<T> {
    const source = new CancellationTokenSource();
    const signal = bridge.getRequestSignal?.();
    const cancel = () => source.cancel();
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await run(source.token);
    } finally {
      signal?.removeEventListener("abort", cancel);
      source.dispose();
    }
  }

  function expose(sessionId: string, session: Session, item: TypeHierarchyItem) {
    const itemId = String(session.items.size);
    session.items.set(itemId, item);
    const result = new TypeHierarchyItem(
      item.kind,
      item.name,
      item.detail ?? "",
      item.uri,
      item.range,
      item.selectionRange,
    );
    result.tags = item.tags;
    return Object.assign(result, { _sessionId: sessionId, _itemId: itemId });
  }

  bridge.commandHandlers.set("vscode.prepareTypeHierarchy", (rawUri, rawPosition) => {
    if (
      !rawUri ||
      typeof rawUri !== "object" ||
      !("scheme" in rawUri) ||
      typeof rawUri.scheme !== "string" ||
      !Position.isPosition(rawPosition)
    ) {
      throw new TypeError("Expected a document URI and position");
    }
    const uri = rawUri instanceof Uri ? rawUri : Uri.from({ ...rawUri, scheme: rawUri.scheme });
    const position = Position.of(rawPosition);
    return withToken(async (token) => {
      if (token.isCancellationRequested) return [];
      const document = await openTextDocument(uri);
      let bestScore = 0;
      let registration: Registration | undefined;
      for (const candidate of registrations) {
        const score = match(candidate.selector, document);
        if (score > 0 && score >= bestScore) {
          bestScore = score;
          registration = candidate;
        }
      }
      if (!registration || token.isCancellationRequested) return [];
      const result = await registration.provider.prepareTypeHierarchy(document, position, token);
      const items = Array.isArray(result) ? result : result ? [result] : [];
      if (!items.length || token.isCancellationRequested || !registrations.has(registration))
        return [];
      const sessionId = `type-${++nextSessionId}`;
      const session: Session = { registration, items: new Map() };
      sessions.set(sessionId, session);
      if (sessions.size > 10) sessions.delete(sessions.keys().next().value!);
      return items.map((item) => expose(sessionId, session, item));
    });
  });

  for (const [command, method] of [
    ["vscode.provideSupertypes", "provideTypeHierarchySupertypes"],
    ["vscode.provideSubtypes", "provideTypeHierarchySubtypes"],
  ] as const) {
    bridge.commandHandlers.set(command, (rawItem) => {
      const handle = rawItem as { _sessionId?: string; _itemId?: string } | undefined;
      const { _sessionId, _itemId } = handle ?? {};
      if (_sessionId === undefined || _itemId === undefined) return [];
      const session = sessions.get(_sessionId);
      const item = session?.items.get(_itemId);
      if (!session || !item) return [];
      return withToken(async (token) => {
        try {
          if (token.isCancellationRequested) return [];
          const items = await session.registration.provider[method](item, token);
          if (!items || token.isCancellationRequested || sessions.get(_sessionId) !== session)
            return [];
          return items.map((child) => expose(_sessionId, session, child));
        } catch (error) {
          if (!token.isCancellationRequested) console.error(error);
          return [];
        }
      });
    });
  }

  return {
    registerTypeHierarchyProvider(selector: DocumentSelector, provider: TypeHierarchyProvider) {
      const registration = { selector, provider };
      registrations.add(registration);
      return new Disposable(() => {
        registrations.delete(registration);
        for (const [id, session] of sessions) {
          if (session.registration === registration) sessions.delete(id);
        }
      });
    },
  };
}
