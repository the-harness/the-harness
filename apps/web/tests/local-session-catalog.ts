import type { SessionSummary } from "@harness/ui-sessions";
import { shallowReactive } from "vue";

// Stands in for SessionCatalog in fixtures that run without the server.
export class LocalSessionCatalog {
  readonly items = shallowReactive<SessionSummary[]>([]);

  request(path: string, body: unknown): boolean {
    if (!path.startsWith("/rpc/sessions.")) return false;
    const input = body as { id: string; workspaceId?: string; title?: string; meta?: never };
    const index = this.items.findIndex((item) => item.id === input.id);
    const current = this.items[index];
    if (path === "/rpc/sessions.create" && !current) {
      this.items.unshift({ id: input.id, workspaceId: input.workspaceId!, createdAt: Date.now() });
    } else if (path === "/rpc/sessions.rename" && current) {
      this.items[index] = { ...current, title: input.title!.trim() };
    } else if (path === "/rpc/sessions.setMeta" && current) {
      this.items[index] = { ...current, meta: input.meta };
    } else if (path === "/rpc/sessions.remove" && current) {
      this.items.splice(index, 1);
    }
    return true;
  }
}
