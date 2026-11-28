import type { ExtHostBridge } from "./bridge.ts";
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  Uri,
  type CancellationToken,
  type Event,
} from "./types.ts";

type Rule = { id: string; kind: string; uriPattern: RegExp };
type Watcher = {
  readonly presentation: unknown;
  readonly onDidChangePresentation: Event<void>;
  dispose(): void;
};
interface LinkPresentationProvider {
  // Extensions supply live presentation data for manifest-declared URI patterns.
  provideLinkPresentationWatcher(resource: Uri, token: CancellationToken): Watcher;
}

export function createLinkPresentationApi(bridge: ExtHostBridge) {
  const rules = new Map<string, Rule>();
  const providers = new Map<string, LinkPresentationProvider>();
  const watchers = new Map<string, Set<Watcher>>();
  const changed = new EventEmitter<void>();
  let rulesSnapshot = "";
  bridge.commandHandlers.set("__links.syncRules", (raw) => {
    const snapshot = JSON.stringify(raw);
    if (snapshot === rulesSnapshot) return;
    rulesSnapshot = snapshot;
    rules.clear();
    for (const rule of raw as { id: string; kind: string; uriPattern: string }[])
      rules.set(rule.id, { ...rule, uriPattern: new RegExp(rule.uriPattern) });
    changed.fire();
  });
  return {
    get linkPresentationRules() {
      return [...rules.values()].filter((rule) => providers.has(rule.id));
    },
    onDidChangeLinkPresentationRules: changed.event,
    registerLinkPresentationProvider(id: string, provider: LinkPresentationProvider) {
      if (!rules.has(id)) throw new Error(`Link presentation provider is not declared: ${id}`);
      if (providers.has(id))
        throw new Error(`Link presentation provider is already registered: ${id}`);
      providers.set(id, provider);
      changed.fire();
      return new Disposable(() => {
        providers.delete(id);
        for (const watcher of watchers.get(id) ?? []) watcher.dispose();
        watchers.delete(id);
        changed.fire();
      });
    },
    createLinkPresentationWatcher(id: string, resource: Uri): Watcher {
      const rule = rules.get(id),
        provider = providers.get(id);
      if (!provider || !rule || !rule.uriPattern.test(resource.toString()))
        throw new Error(`Link presentation provider unavailable for ${resource.toString()}: ${id}`);
      const token = new CancellationTokenSource();
      let inner: Watcher;
      try {
        inner = provider.provideLinkPresentationWatcher(resource, token.token);
      } catch (error) {
        token.dispose();
        throw error;
      }
      const active = watchers.get(id) ?? new Set<Watcher>();
      watchers.set(id, active);
      let disposed = false;
      const watcher = {
        get presentation() {
          return inner.presentation;
        },
        onDidChangePresentation: inner.onDidChangePresentation,
        dispose() {
          if (disposed) return;
          disposed = true;
          active.delete(watcher);
          token.cancel();
          inner.dispose();
          token.dispose();
        },
      };
      active.add(watcher);
      return watcher;
    },
  };
}
