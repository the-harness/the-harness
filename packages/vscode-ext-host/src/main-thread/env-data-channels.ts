import type { ExtensionHostService } from "../service.ts";

export function createMainThreadDataChannels(host: Pick<ExtensionHostService, "executeCommand">) {
  return {
    getDataChannel<T>(sessionId: string, channelId: string) {
      return {
        async sendData(data: T): Promise<void> {
          await host.executeCommand(sessionId, "__env.onDidReceiveData", channelId, data);
        },
      };
    },
  };
}
