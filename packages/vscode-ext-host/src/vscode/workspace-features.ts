import type { ExtHostBridge } from "./bridge.ts";
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  Uri,
  type CancellationToken,
  type Event,
} from "./types.ts";

type ProviderResult<T> = T | null | undefined | PromiseLike<T | null | undefined>;
type Folder = { uri: Uri; name: string; index: number };
type TimelineProvider = {
  onDidChange?: Event<unknown>;
  provideTimeline(uri: Uri, options: unknown, token: CancellationToken): ProviderResult<unknown>;
};
type WorkspaceTimelineProvider = {
  onDidChange?: Event<unknown>;
  provideTimeline(options: unknown, token: CancellationToken): ProviderResult<unknown>;
};
type IdentityProvider = {
  provideEditSessionIdentity(folder: Folder, token: CancellationToken): ProviderResult<string>;
  provideEditSessionIdentityMatch?(
    identity: string,
    other: string,
    token: CancellationToken,
  ): ProviderResult<number>;
};

export function createWorkspaceFeatures(bridge: ExtHostBridge) {
  let trusted = true;
  let trustedResources: Uri[] | undefined;
  const grantTrust = new EventEmitter<void>();
  const trustedFolders = new EventEmitter<void>();
  const folderLocations = new EventEmitter<unknown>();
  const beforeIdentity = new EventEmitter<{
    workspaceFolder: Folder;
    token: CancellationToken;
    waitUntil(value: PromiseLike<unknown>): void;
  }>();
  const timelines = new Map<
    string,
    {
      label: string;
      schemes: string[];
      provider: TimelineProvider;
      revision: number;
      subscription?: Disposable;
    }
  >();
  const workspaceTimelines = new Map<
    string,
    { label: string; provider: WorkspaceTimelineProvider }
  >();
  const identities = new Map<string, IdentityProvider>();
  const canonical = new Map<
    string,
    {
      provideCanonicalUri(
        uri: Uri,
        options: { targetScheme: string },
        token: CancellationToken,
      ): ProviderResult<Uri>;
    }
  >();
  const withToken = async (callback: (token: CancellationToken) => unknown) => {
    const source = new CancellationTokenSource();
    try {
      return await callback(source.token);
    } finally {
      source.dispose();
    }
  };
  const register = <T>(map: Map<string, T>, key: string, value: T) => {
    if (map.has(key)) throw new Error(`Provider already registered: ${key}`);
    map.set(key, value);
    return new Disposable(() => {
      if (map.get(key) === value) map.delete(key);
    });
  };
  bridge.commandHandlers.set("__ws.syncTrust", (raw) => {
    const next = raw as { isTrusted: boolean; trustedResources?: Parameters<typeof Uri.from>[0][] };
    const granted = !trusted && next.isTrusted;
    trusted = next.isTrusted;
    trustedResources = next.trustedResources?.map((value) => Uri.from(value));
    if (granted) grantTrust.fire();
    trustedFolders.fire();
  });
  bridge.commandHandlers.set("__ws.onDidChangeWorkspaceFolderLocations", (event) =>
    folderLocations.fire(event),
  );
  bridge.commandHandlers.set("__ws.timelineProviders", () =>
    [...timelines].map(([id, entry]) => ({
      id,
      label: entry.label,
      schemes: entry.schemes,
      revision: entry.revision,
    })),
  );
  bridge.commandHandlers.set("__ws.provideTimeline", (id, rawUri, options) =>
    withToken((token) => {
      const entry = timelines.get(String(id));
      const uri = Uri.from(rawUri as Parameters<typeof Uri.from>[0]);
      if (!entry || !entry.schemes.includes(uri.scheme))
        throw new Error(`No timeline provider for ${String(id)} and ${uri.scheme}`);
      return entry.provider.provideTimeline(uri, options, token);
    }),
  );
  bridge.commandHandlers.set("__ws.provideWorkspaceTimeline", (id, options) =>
    withToken((token) => {
      const entry = workspaceTimelines.get(String(id));
      if (!entry) throw new Error(`No workspace timeline provider: ${String(id)}`);
      return entry.provider.provideTimeline(options, token);
    }),
  );
  bridge.commandHandlers.set("__ws.provideEditSessionIdentity", (rawFolder) =>
    withToken(async (token) => {
      const raw = rawFolder as Omit<Folder, "uri"> & { uri: Parameters<typeof Uri.from>[0] };
      const folder = { ...raw, uri: Uri.from(raw.uri) };
      const provider = identities.get(folder.uri.scheme);
      if (!provider) throw new Error(`No edit session identity provider: ${folder.uri.scheme}`);
      const promises: PromiseLike<unknown>[] = [];
      let accepting = true;
      beforeIdentity.fire({
        workspaceFolder: folder,
        token,
        waitUntil: (value) => {
          if (!accepting)
            throw new Error("waitUntil must be called during the edit session identity event");
          promises.push(value);
        },
      });
      accepting = false;
      await Promise.all(promises);
      return await provider.provideEditSessionIdentity(folder, token);
    }),
  );

  return {
    get isTrusted() {
      return trusted;
    },
    isAgentSessionsWorkspace: false,
    onDidGrantWorkspaceTrust: grantTrust.event,
    onDidChangeWorkspaceTrustedFolders: trustedFolders.event,
    onDidChangeWorkspaceFolderLocations: folderLocations.event,
    async isResourceTrusted(uri: Uri): Promise<boolean> {
      return trustedResources
        ? trustedResources.some(
            (root) =>
              root.scheme === uri.scheme &&
              root.authority === uri.authority &&
              (root.path === uri.path || uri.path.startsWith(root.path.replace(/\/$/, "") + "/")),
          )
        : trusted;
    },
    async requestResourceTrust(options: {
      uri: Uri;
      message?: string;
    }): Promise<boolean | undefined> {
      if (await this.isResourceTrusted(options.uri)) return true;
      return (await bridge.callMain("workspace.requestResourceTrust", {
        ...options,
        uri: options.uri.toJSON(),
      })) as boolean | undefined;
    },
    async requestWorkspaceTrust(options?: { message?: string }): Promise<boolean | undefined> {
      if (trusted) return true;
      return (await bridge.callMain("workspace.requestWorkspaceTrust", options)) as
        | boolean
        | undefined;
    },
    registerTimelineProvider(
      id: string,
      label: string,
      schemes: string | readonly string[],
      provider: TimelineProvider,
    ): Disposable {
      const entry = {
        label,
        schemes: typeof schemes === "string" ? [schemes] : [...schemes],
        provider,
        revision: 0,
        subscription: undefined as Disposable | undefined,
      };
      const registration = register(timelines, id, entry);
      entry.subscription = provider.onDidChange?.(() => {
        entry.revision++;
      });
      return Disposable.from(registration, entry.subscription ?? new Disposable(() => {}));
    },
    registerWorkspaceTimelineProvider(
      id: string,
      label: string,
      provider: WorkspaceTimelineProvider,
    ): Disposable {
      return register(workspaceTimelines, id, { label, provider });
    },
    registerEditSessionIdentityProvider(scheme: string, provider: IdentityProvider): Disposable {
      return register(identities, scheme, provider);
    },
    onWillCreateEditSessionIdentity: beforeIdentity.event,
    registerCanonicalUriProvider(
      scheme: string,
      provider: typeof canonical extends Map<string, infer T> ? T : never,
    ): Disposable {
      return register(canonical, scheme, provider);
    },
    async getCanonicalUri(
      uri: Uri,
      options: { targetScheme: string },
      token: CancellationToken,
    ): Promise<Uri | undefined> {
      return (
        (await canonical.get(uri.scheme)?.provideCanonicalUri(uri, options, token)) ?? undefined
      );
    },
  };
}
