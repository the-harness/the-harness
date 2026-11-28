```ts
class SecretStorageService {
  constructor(options: { readonly profileId: string; readonly key?: Uint8Array }); // Uses a deployment-supplied 32-byte key.
  get(extensionId: string, key: string): string | undefined;
  store(
    extensionId: string,
    key: string,
    value: string,
    options?: { readonly keepExisting?: boolean },
  ): "changed" | "unchanged" | "conflict";
  delete(extensionId: string, key: string): boolean; // Reports whether a value was removed.
}
```
