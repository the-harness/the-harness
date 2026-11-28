import type { UiQuickInputService } from "@harness/ui-quick-input";
import type {
  AuthenticationGetSessionOptions,
  AuthenticationProviderOptions,
  AuthenticationSession,
} from "../vscode/authentication.ts";

export interface AuthenticationHost {
  executeCommand(sessionId: string, command: string, args: unknown[]): Promise<unknown>;
  didChangeSessions?(provider: { id: string; label: string }, originSessionId: string): void;
}

export function createMainThreadAuthentication(
  quickInput: Pick<UiQuickInputService, "showQuickPick">,
  host?: AuthenticationHost,
) {
  const providers = new Map<
    string,
    { label: string; sessionId: string; options: AuthenticationProviderOptions }
  >();

  return async (method: string, args: unknown[], sessionId = ""): Promise<unknown> => {
    if (method === "auth.registerProvider") {
      const [id, label, options = {}] = args as [string, string, AuthenticationProviderOptions?];
      if (providers.has(id))
        throw new Error(`An authentication provider with id '${id}' is already registered.`);
      providers.set(id, { label, sessionId, options });
      return undefined;
    }
    if (method === "auth.unregisterProvider") {
      const [id] = args as [string];
      if (providers.get(id)?.sessionId === sessionId) providers.delete(id);
      return undefined;
    }
    if (method === "auth.unregisterSession") {
      for (const [id, provider] of providers)
        if (provider.sessionId === sessionId) providers.delete(id);
      return undefined;
    }
    if (method === "auth.sessionsChanged") {
      const [id] = args as [string];
      const provider = providers.get(id);
      if (provider?.sessionId === sessionId)
        host?.didChangeSessions?.({ id, label: provider.label }, sessionId);
      return undefined;
    }
    if (method === "auth.getSession" || method === "auth.getAccounts") {
      const [providerId, scopes, options = {}] = args as [
        string,
        string[] | undefined,
        AuthenticationGetSessionOptions?,
      ];
      const provider = providers.get(providerId);
      if (!provider)
        throw new Error(`No authentication provider '${providerId}' is currently registered.`);
      if (!host) throw new Error("Authentication provider routing is unavailable");
      if (options.silent && (options.createIfNone || options.forceNewSession)) {
        throw new Error("silent cannot be combined with createIfNone or forceNewSession");
      }
      if (options.createIfNone && options.forceNewSession)
        throw new Error("createIfNone cannot be combined with forceNewSession");
      const providerOptions = options.account ? { account: options.account } : {};
      const sessions = (await host.executeCommand(
        provider.sessionId,
        `__auth.getSessions.${providerId}`,
        [scopes, providerOptions],
      )) as readonly AuthenticationSession[];
      if (method === "auth.getAccounts") {
        return [
          ...new Map(sessions.map((session) => [session.account.id, session.account])).values(),
        ];
      }
      const matching = options.account
        ? sessions.filter((session) => session.account.id === options.account!.id)
        : sessions;
      if (!options.forceNewSession && matching.length) {
        if (
          matching.length === 1 ||
          !provider.options.supportsMultipleAccounts ||
          options.account ||
          options.silent
        )
          return matching[0];
        const selected = await quickInput.showQuickPick(
          matching.map((session) => ({ label: session.account.label, session })),
          { title: `Choose an account for ${provider.label}` },
        );
        return selected?.session;
      }
      if (!options.createIfNone && !options.forceNewSession) return undefined;
      return await host.executeCommand(provider.sessionId, `__auth.createSession.${providerId}`, [
        scopes ?? [],
        providerOptions,
      ]);
    }

    return undefined;
  };
}
