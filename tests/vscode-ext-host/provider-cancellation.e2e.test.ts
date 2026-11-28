import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { createMainThreadLanguages } from "../../packages/vscode-ext-host/src/main-thread/languages.ts";
import {
  CancellationTokenSource,
  Position,
  TextDocumentData,
  Uri,
} from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const extensionSource = String.raw`
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  const started = [], cancelled = [];
  async function waitForCancellation(name, token) {
    started.push(name);
    await new Promise(resolve => token.onCancellationRequested(() => {
      cancelled.push(name);
      resolve();
    }));
  }
  subscriptions.push(vscode.languages.registerCompletionItemProvider("typescript", {
    async provideCompletionItems(_document, position, token) {
      if (position.character === 0) {
        await waitForCancellation("provide", token);
        return [new vscode.CompletionItem("stale")];
      }
      return [new vscode.CompletionItem("fresh")];
    },
    async resolveCompletionItem(item, token) {
      await waitForCancellation("resolve", token);
      return { ...item, detail: "stale detail" };
    },
  }));
  subscriptions.push(vscode.languages.registerHoverProvider("typescript", {
    async provideHover(_document, _position, token) {
      await waitForCancellation("hover", token);
      return new vscode.Hover("stale hover");
    },
  }));
  subscriptions.push(vscode.commands.registerCommand("cancellation.state", () => ({
    started: [...started], cancelled: [...cancelled],
  })));
  subscriptions.push(vscode.commands.registerCommand("cancellation.checkError", async typed => {
    try {
      await vscode.commands.executeCommand("fixture.cancellationError", typed);
    } catch (error) {
      if ((error instanceof vscode.CancellationError) !== typed) {
        throw new Error("Unexpected cancellation error type inside the worker");
      }
      throw error;
    }
  }));
};
`;

it(
  "cancels in-flight completion and resolve calls through the gateway and a real extension worker",
  {
    timeout: 30_000,
  },
  async () => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "provider-cancellation-"));
    const directory = join(root, "extensions/fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        publisher: "regression",
        name: "provider-cancellation",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:cancellation.state"],
      }),
    );
    writeFileSync(join(directory, "extension.cjs"), extensionSource);

    const { modules, scope, service: host, dispose } = await createExtensionHostFixture();
    const [di, gateway, rpc, stream, transport, llm, providers, extHost, sqlite, secrets, state] =
      await Promise.all([
        modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
        modules.load<typeof import("../../packages/gateway/src/index.ts")>(
          "/packages/gateway/src/index.ts",
        ),
        modules.load<typeof import("../../packages/rpc/src/index.ts")>(
          "/packages/rpc/src/index.ts",
        ),
        modules.load<typeof import("../../packages/stream/src/index.ts")>(
          "/packages/stream/src/index.ts",
        ),
        modules.load<typeof import("../../packages/transport/src/index.ts")>(
          "/packages/transport/src/index.ts",
        ),
        modules.load<typeof import("../../packages/llm/src/index.ts")>(
          "/packages/llm/src/index.ts",
        ),
        modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
          "/packages/model-provider/src/index.ts",
        ),
        modules.load<typeof import("../../packages/vscode-ext-host/src/index.ts")>(
          "/packages/vscode-ext-host/src/index.ts",
        ),
        modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
          "/packages/sqlite/src/index.ts",
        ),
        modules.load<typeof import("../../packages/secret-storage/src/index.ts")>(
          "/packages/secret-storage/src/index.ts",
        ),
        modules.load<typeof import("../../packages/state-sync/src/index.ts")>(
          "/packages/state-sync/src/index.ts",
        ),
      ]);
    scope.provideAll([
      rpc.RpcServerService,
      stream.StreamServerService,
      state.StateSyncServerService,
      llm.LlmService,
      providers.ProviderManager,
      di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
      di.createDescriptor(secrets.SecretStorageService, { profileId: "fixture" }),
    ]);
    scope.setup(() => extHost.useExtHostHandlers());
    const server = createServer();
    gateway.attachGateway(server, async () => ({
      rpcServer: scope.get(rpc.RpcServerService),
      streamServer: scope.get(stream.StreamServerService),
    }));

    const client = di.createRootScope();
    client.provideAll([
      transport.WebTransportConnection,
      [transport.Transport, transport.WebTransport],
      rpc.RpcClientService,
    ]);
    const remote = client.run(() =>
      client.get(rpc.RpcClientService).use(extHost.ExtHostRpcContract),
    );
    const { CancellationError } = await modules.load<
      typeof import("../../packages/vscode-types/src/index.ts")
    >("/packages/vscode-types/src/index.ts");
    const { encodeExtHostError } = await modules.load<
      typeof import("../../packages/vscode-ext-host/src/wire-error.ts")
    >("/packages/vscode-ext-host/src/wire-error.ts");
    let provider: Record<string, (...args: unknown[]) => Promise<unknown>> | undefined;
    let hoverProvider: NonNullable<typeof provider> | undefined;
    const languages = createMainThreadLanguages(
      {
        registerCompletionItemProvider(_selector: unknown, value: NonNullable<typeof provider>) {
          provider = value;
          return {
            dispose() {
              provider = undefined;
            },
            registerHoverProvider(_selector: unknown, value: NonNullable<typeof provider>) {
              hoverProvider = value;
              return {
                dispose() {
                  hoverProvider = undefined;
                },
              };
            },
          };
        },
      } as never,
      (sessionId, command, args, signal) =>
        remote.executeCommand({ sessionId, command, args }, signal),
    );
    const off = host.onMainThreadCall(async (sessionId, method, args, requestId) => {
      if (!requestId) return;
      if (method === "commands.execute" && args[0] === "fixture.cancellationError") {
        const error =
          args[1] === true
            ? new CancellationError()
            : Object.assign(new Error("Canceled"), { name: "Canceled" });
        await remote.resolveMainCall({
          sessionId,
          requestId,
          ...encodeExtHostError(error),
        });
        return;
      }
      try {
        const value = method.startsWith("languages.")
          ? await languages(sessionId, method, args)
          : method === "memento.load"
            ? {}
            : undefined;
        host.resolveMainCall(requestId, value);
      } catch (error) {
        host.resolveMainCall(requestId, undefined, String(error));
      }
    });

    const sessionId = "completion-cancellation";
    const status = () => host.executeCommand(sessionId, "cancellation.state");
    const provideToken = new CancellationTokenSource();
    const resolveToken = new CancellationTokenSource();
    const hoverToken = new CancellationTokenSource();
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      vi.stubGlobal("location", {
        protocol: "http:",
        host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      await host.scanExtensions(join(root, "extensions"));
      await host.startSession(sessionId, [root], { storageRoot: join(root, "storage") });
      await status();
      await expect(
        host.executeCommand(sessionId, "cancellation.checkError", true),
      ).rejects.toBeInstanceOf(CancellationError);
      const plainError = await host
        .executeCommand(sessionId, "cancellation.checkError", false)
        .catch((error: unknown) => error);
      expect(plainError).toMatchObject({ name: "Canceled", message: "Canceled" });
      expect(plainError).not.toBeInstanceOf(CancellationError);
      await vi.waitFor(() => expect(provider).toBeDefined());
      const document = new TextDocumentData({
        uri: Uri.file(join(root, "main.ts")).toJSON(),
        text: "item",
        version: 1,
        languageId: "typescript",
        isDirty: false,
        eol: 1,
      });
      const provide = (character: number, token: CancellationTokenSource["token"]) =>
        provider!.provideCompletionItems!(document, new Position(0, character), token, {
          triggerKind: 0,
        });

      const pending = provide(0, provideToken.token);
      await vi.waitFor(async () => expect(await status()).toMatchObject({ started: ["provide"] }));
      provideToken.cancel();
      await expect(pending).resolves.toBeUndefined();
      await vi.waitFor(async () =>
        expect(await status()).toMatchObject({ cancelled: ["provide"] }),
      );

      const fresh = (await provide(1, resolveToken.token)) as {
        items: { label: string }[];
        dispose(): void;
      };
      expect(fresh.items).toMatchObject([{ label: "fresh" }]);
      const resolving = provider!.resolveCompletionItem!(fresh.items[0], resolveToken.token);
      await vi.waitFor(async () =>
        expect(await status()).toMatchObject({ started: ["provide", "resolve"] }),
      );
      resolveToken.cancel();
      await expect(resolving).resolves.toBeUndefined();
      await vi.waitFor(async () =>
        expect(await status()).toMatchObject({ cancelled: ["provide", "resolve"] }),
      );
      fresh.dispose();
      await vi.waitFor(() => expect(hoverProvider).toBeDefined());
      const hover = hoverProvider!.provideHover!(document, new Position(0, 0), hoverToken.token);
      await vi.waitFor(async () =>
        expect(await status()).toMatchObject({ started: ["provide", "resolve", "hover"] }),
      );
      hoverToken.cancel();
      await expect(hover).resolves.toBeUndefined();
      await vi.waitFor(async () =>
        expect(await status()).toMatchObject({ cancelled: ["provide", "resolve", "hover"] }),
      );
      await remote.executeCommand({ sessionId, command: "cancellation.state" });
    } finally {
      provideToken.dispose();
      resolveToken.dispose();
      hoverToken.dispose();
      try {
        client.dispose();
        await dispose(sessionId);
      } finally {
        off();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        vi.unstubAllGlobals();
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
