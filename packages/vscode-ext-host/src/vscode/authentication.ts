import type { ExtHostBridge } from "./bridge.ts";
import { Disposable, EventEmitter, type Event } from "./types.ts";

export interface AuthenticationSessionAccountInformation {
  readonly id: string;
  readonly label: string;
}

export interface AuthenticationSession {
  readonly id: string;
  readonly accessToken: string;
  readonly idToken?: string;
  readonly account: AuthenticationSessionAccountInformation;
  readonly scopes: readonly string[];
}

export interface AuthenticationProviderSessionOptions {
  account?: AuthenticationSessionAccountInformation;
}

export interface AuthenticationGetSessionOptions extends AuthenticationProviderSessionOptions {
  createIfNone?: boolean | { detail?: string };
  forceNewSession?: boolean | { detail?: string };
  silent?: boolean;
  clearSessionPreference?: boolean;
}

export interface AuthenticationProviderOptions {
  readonly supportsMultipleAccounts?: boolean;
}

export interface AuthenticationProvider {
  // Extensions implement this interface to supply authentication sessions.
  readonly onDidChangeSessions: Event<{
    readonly added?: readonly AuthenticationSession[];
    readonly removed?: readonly AuthenticationSession[];
    readonly changed?: readonly AuthenticationSession[];
  }>;
  getSessions(
    scopes: readonly string[] | undefined,
    options: AuthenticationProviderSessionOptions,
  ): PromiseLike<readonly AuthenticationSession[]>;
  createSession(
    scopes: readonly string[],
    options: AuthenticationProviderSessionOptions,
  ): PromiseLike<AuthenticationSession>;
  removeSession(sessionId: string): PromiseLike<void>;
}

export function createAuthenticationNamespace(bridge: ExtHostBridge) {
  const providers = new Map<string, { ready: Promise<unknown>; dispose(): void }>();
  const operations = new Map<string, Promise<unknown>>();
  function queue(id: string, operation: () => Promise<unknown>): Promise<unknown> {
    const next = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    operations.set(id, next);
    void next
      .finally(() => {
        if (operations.get(id) === next) operations.delete(id);
      })
      .catch(() => {});
    return next;
  }
  const sessionsChangedEmitter = new EventEmitter<{
    readonly provider: { id: string; label: string };
  }>();
  bridge.commandHandlers.set("__auth.onDidChangeSessions", (provider) => {
    sessionsChangedEmitter.fire({ provider: provider as { id: string; label: string } });
  });

  async function getSession(
    providerId: string,
    scopes: readonly string[],
    options: AuthenticationGetSessionOptions & { createIfNone: true | { detail?: string } },
  ): Promise<AuthenticationSession>;
  async function getSession(
    providerId: string,
    scopes: readonly string[],
    options: AuthenticationGetSessionOptions & { forceNewSession: true | { detail?: string } },
  ): Promise<AuthenticationSession>;
  async function getSession(
    providerId: string,
    scopes: readonly string[],
    options?: AuthenticationGetSessionOptions,
  ): Promise<AuthenticationSession | undefined>;
  async function getSession(
    providerId: string,
    scopes: readonly string[],
    options: AuthenticationGetSessionOptions = {},
  ): Promise<AuthenticationSession | undefined> {
    if (!Array.isArray(scopes))
      throw new Error("WWW-Authenticate requests are not supported by this compatibility host");
    if (!providers.has(providerId))
      await bridge.activateByEvent?.(`onAuthenticationRequest:${providerId}`);
    await (providers.get(providerId)?.ready ?? operations.get(providerId));
    return (await bridge.callMain("auth.getSession", providerId, [...scopes], options)) as
      | AuthenticationSession
      | undefined;
  }

  return {
    onDidChangeSessions: sessionsChangedEmitter.event,
    getSession,

    registerAuthenticationProvider(
      id: string,
      label: string,
      provider: AuthenticationProvider,
      options: AuthenticationProviderOptions = {},
    ): Disposable {
      if (providers.has(id))
        throw new Error(`An authentication provider with id '${id}' is already registered.`);
      const commands = [
        `__auth.getSessions.${id}`,
        `__auth.createSession.${id}`,
        `__auth.removeSession.${id}`,
      ];
      bridge.commandHandlers.set(commands[0]!, (scopes, options) =>
        provider.getSessions(
          scopes == null ? undefined : (scopes as readonly string[]),
          (options as AuthenticationProviderSessionOptions) ?? {},
        ),
      );
      bridge.commandHandlers.set(commands[1]!, (scopes, options) =>
        provider.createSession(
          scopes as readonly string[],
          (options as AuthenticationProviderSessionOptions) ?? {},
        ),
      );
      bridge.commandHandlers.set(commands[2]!, (sessionId) =>
        provider.removeSession(sessionId as string),
      );
      const ready = queue(id, () => bridge.callMain("auth.registerProvider", id, label, options));
      let disposed = false;
      const subscription = provider.onDidChangeSessions(() => {
        if (disposed) return;
        sessionsChangedEmitter.fire({ provider: { id, label } });
        void ready
          .then(() => {
            if (!disposed) return bridge.callMain("auth.sessionsChanged", id);
          })
          .catch((error: unknown) => console.error(error));
      });
      const registration = {
        ready,
        dispose() {
          if (disposed) return;
          disposed = true;
          subscription.dispose();
          if (providers.get(id) !== registration) return;
          providers.delete(id);
          for (const command of commands) bridge.commandHandlers.delete(command);
          void queue(id, () => bridge.callMain("auth.unregisterProvider", id)).catch(
            (error: unknown) => console.error(error),
          );
        },
      };
      providers.set(id, registration);
      void ready.catch((error: unknown) => {
        registration.dispose();
        console.error(error);
      });
      return new Disposable(() => registration.dispose());
    },

    async getAccounts(
      providerId: string,
    ): Promise<readonly AuthenticationSessionAccountInformation[]> {
      if (!providers.has(providerId))
        await bridge.activateByEvent?.(`onAuthenticationRequest:${providerId}`);
      await (providers.get(providerId)?.ready ?? operations.get(providerId));
      return (await bridge.callMain(
        "auth.getAccounts",
        providerId,
      )) as readonly AuthenticationSessionAccountInformation[];
    },
  };
}
