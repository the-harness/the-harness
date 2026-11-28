import {
  CancellationTokenSource,
  Disposable,
  Location,
  Range,
  SymbolInformation,
  SymbolKind,
  SymbolTag,
  Uri,
  type CancellationToken,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

type ProviderResult<T> = T | null | undefined | PromiseLike<T | null | undefined>;

// Extensible interface implemented by extensions.
export interface WorkspaceSymbolProvider<T extends SymbolInformation = SymbolInformation> {
  provideWorkspaceSymbols(query: string, token: CancellationToken): ProviderResult<T[]>;
  resolveWorkspaceSymbol?(symbol: T, token: CancellationToken): ProviderResult<T>;
}

type Match = { symbol: SymbolInformation; uri: string; canResolve: boolean };

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareMatches(left: Match, right: Match): number {
  const a = left.symbol;
  const b = right.symbol;
  const comparison =
    compareText(a.name, b.name) || a.kind - b.kind || compareText(left.uri, right.uri);
  if (comparison) return comparison;

  const first = a.location.range;
  const second = b.location.range;
  if (first && second) {
    if (first.end.isBeforeOrEqual(second.start) || second.end.isBeforeOrEqual(first.start)) {
      const byRange = first.start.compareTo(second.start) || first.end.compareTo(second.end);
      if (byRange) return byRange;
    }
  } else if (left.canResolve !== right.canResolve) {
    return left.canResolve ? -1 : 1;
  }

  return compareText(a.containerName ?? "", b.containerName ?? "");
}

function toMatch(value: SymbolInformation, canResolve: boolean): Match | undefined {
  if (typeof value?.name !== "string" || !value.name || !Uri.isUri(value.location?.uri)) return;
  const { uri, range } = value.location;
  if (range != null && !Range.isRange(range)) return;
  const kind =
    typeof value.kind === "number" && typeof SymbolKind[value.kind] === "string"
      ? value.kind
      : SymbolKind.Property;
  const symbol = new SymbolInformation(
    value.name,
    kind,
    value.containerName ?? "",
    new Location(uri, range),
  );
  if (Array.isArray(value.tags))
    symbol.tags = value.tags.filter((tag) => tag === SymbolTag.Deprecated);
  return { symbol, uri: uri.toString(), canResolve };
}

export function createWorkspaceSymbolApi(bridge: ExtHostBridge) {
  const providers = new Set<{ provider: WorkspaceSymbolProvider }>();

  bridge.commandHandlers.set("vscode.executeWorkspaceSymbolProvider", async (query) => {
    if (typeof query !== "string") throw new TypeError("Workspace symbol query must be a string");
    const signal = bridge.getRequestSignal?.();
    if (signal?.aborted) return [];
    const cancellation = new CancellationTokenSource();
    const cancel = () => cancellation.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const matches: Match[] = [];
      await Promise.all(
        [...providers].map(async (registration) => {
          const { provider } = registration;
          try {
            const values = await provider.provideWorkspaceSymbols(query, cancellation.token);
            if (
              !Array.isArray(values) ||
              cancellation.token.isCancellationRequested ||
              !providers.has(registration)
            )
              return;
            const canResolve = typeof provider.resolveWorkspaceSymbol === "function";
            for (const value of values) {
              const match = toMatch(value, canResolve);
              if (match) matches.push(match);
            }
          } catch (error) {
            if (!cancellation.token.isCancellationRequested) console.error(error);
          }
        }),
      );
      if (cancellation.token.isCancellationRequested) return [];
      const unique: Match[] = [];
      for (const match of matches.sort(compareMatches)) {
        const previous = unique.at(-1);
        if (!previous || compareMatches(previous, match) !== 0) unique.push(match);
      }
      return unique.map(({ symbol }) => symbol);
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancellation.dispose();
    }
  });

  return {
    registerWorkspaceSymbolProvider<T extends SymbolInformation>(
      provider: WorkspaceSymbolProvider<T>,
    ): Disposable {
      const registration = { provider };
      providers.add(registration);
      return new Disposable(() => providers.delete(registration));
    },
  };
}
