export function log(event: string): void {
  ((globalThis as { __hmrClientLog?: string[] }).__hmrClientLog ??= []).push(event);
}
