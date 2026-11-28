# @harness/harness-stdio

```ts
export interface StdioHarnessOptions {
  readonly meta: HarnessMetadata;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class StdioHarnessService {
  readonly meta: HarnessMetadata;
  constructor(options: StdioHarnessOptions);
  resolveRuntime(): Promise<RootServerTransport>;
  toRegistration(): HarnessRegistration;
  dispose(): void; // Permanently retires this service and its resolved runtime.
}

export function serveStdioRuntime(
  serverTransport: RootServerTransport,
  input?: Readable,
  output?: Writable,
): () => void;
```
