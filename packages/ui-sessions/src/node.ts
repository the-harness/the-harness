import { inject, optionalInject, useServices } from "@harness/di";
import { RpcServerService } from "@harness/rpc";
import { SessionCatalog } from "@harness/session-catalog";
import { SessionManager } from "@harness/session-manager";
import { SessionTitleService } from "@harness/session-title";
import { StateSyncServerService } from "@harness/state-sync";
import { StreamServerService } from "@harness/stream";
import { ServerTransport } from "@harness/transport";
import { SessionsRpcContract, SessionsStateSyncContract } from "./types.ts";

export function useSessionsHandlers(): void {
  const sessions = inject(SessionCatalog);
  const sessionTitle = optionalInject(SessionTitleService);
  const manager = inject(SessionManager);
  const { create, rename, setMeta, remove } = SessionsRpcContract.endpoints;
  inject(StateSyncServerService).useHandlers(SessionsStateSyncContract, {
    items: () => sessions.host,
  });
  // RpcServerService does not validate input, and a rejected catalog row would stall later writes.
  inject(RpcServerService).useHandlers(SessionsRpcContract, {
    create: (input) => void sessions.create(create.input.parse(input)),
    rename: (input) => {
      const { id, title } = rename.input.parse(input);
      if (sessionTitle) sessionTitle.rename(id, title);
      else sessions.rename(id, title);
    },
    setMeta: (input) => {
      const { id, meta } = setMeta.input.parse(input);
      sessions.setMeta(id, meta);
    },
    remove: (input) => sessions.remove(remove.input.parse(input).id),
  });

  // Calls scoped to a session id reach the handlers registered in that session's scope.
  const transport = inject(ServerTransport);
  manager.useSessionSetup((sessionId) =>
    useServices([
      [ServerTransport, transport.childScope(sessionId)],
      RpcServerService,
      StreamServerService,
      StateSyncServerService,
    ]),
  );
}
