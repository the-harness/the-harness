import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type RpcModule = typeof import("../../packages/rpc/src/index.ts");
type StreamModule = typeof import("../../packages/stream/src/index.ts");
type TransportModule = typeof import("../../packages/transport/src/index.ts");
type ZodModule = { z: typeof import("zod").z };

let harness: HarnessModules;
let di: DiModule;
let rpc: RpcModule;
let stream: StreamModule;
let transport: TransportModule;
let zod: ZodModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, rpc, stream, transport, zod] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<RpcModule>("/packages/rpc/src/index.ts"),
    harness.load<StreamModule>("/packages/stream/src/index.ts"),
    harness.load<TransportModule>("/packages/transport/src/index.ts"),
    harness.load<ZodModule>("/packages/rpc/node_modules/zod/index.js"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

it.each(["rpc", "stream"] as const)(
  "reacquires a live %s client from the last consumer's abort callback",
  async (kind) => {
    const root = di.createRootScope();
    const started = Promise.withResolvers<void>();
    const rebound = Promise.withResolvers<(value: string) => Promise<string>>();

    class TestTransport extends transport.Transport {
      override async request(_path: string, body?: unknown, signal?: AbortSignal) {
        if (!signal) throw new Error("Expected a scoped abort signal");
        signal.throwIfAborted();
        if (body !== "pending") return body;
        return await new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              try {
                rebound.resolve(replacementScope.run(acquire));
              } catch (error) {
                rebound.reject(error);
              }
              reject(signal.reason);
            },
            { once: true },
          );
          started.resolve();
        });
      }

      override async *openStream(path: string, body?: unknown, signal?: AbortSignal) {
        yield await this.request(path, body, signal);
      }

      override childScope() {
        return di.createDescriptor(TestTransport);
      }
    }

    const firstScope = root.createChild();
    const lastScope = root.createChild();
    const replacementScope = root.createChild();
    const serviceId = kind === "rpc" ? rpc.RpcClientService : stream.StreamClientService;
    root.provideAll([[transport.Transport, TestTransport], serviceId]);

    const acquire = (() => {
      const schema = zod.z.string();
      if (kind === "rpc") {
        const service = root.get(rpc.RpcClientService);
        const contract = rpc.defineRpcContract("client-retirement", {
          echo: rpc.rpc.call(schema, schema),
        });
        return () => service.use(contract).echo;
      }
      const service = root.get(stream.StreamClientService);
      const contract = stream.defineStreamContract("client-retirement", {
        echo: stream.stream.channel(schema, schema),
      });
      return () => {
        const client = service.use(contract);
        return async (value: string) => {
          for await (const chunk of client.echo(value)) return chunk;
          throw new Error("Expected one stream chunk");
        };
      };
    })();

    try {
      const first = firstScope.run(acquire);
      const last = lastScope.run(acquire);
      const pending = first("pending");
      const cancellation = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await started.promise;
      firstScope.dispose();
      await expect(last("still shared")).resolves.toBe("still shared");

      lastScope.dispose();
      await cancellation;
      const replacement = await rebound.promise;
      await expect(replacement("reused")).resolves.toBe("reused");

      if (kind === "rpc") root.unprovide(rpc.RpcClientService);
      else root.unprovide(stream.StreamClientService);
      expect(() => replacementScope.run(acquire)).toThrow("is disposed");
    } finally {
      root.dispose();
    }
  },
);
