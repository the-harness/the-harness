interface RootTransport {
  handleCall(scope: readonly string[], path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  handleStream(
    scope: readonly string[],
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): AsyncIterable<unknown>;
}

// Calls a scope's RootServerTransport the way a gateway client would.
export function serverCalls(transport: unknown) {
  const root = transport as RootTransport;
  return {
    handleCall: (
      route: string,
      scope: readonly string[],
      body?: unknown,
      signal = new AbortController().signal,
    ) => root.handleCall(scope, route, body, signal),
    handleStream: (
      path: string,
      scope: readonly string[],
      body?: unknown,
      signal = new AbortController().signal,
    ) => root.handleStream(scope, path, body, signal),
  };
}
