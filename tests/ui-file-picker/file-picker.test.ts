import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type FilePickerModule = typeof import("../../packages/ui-file-picker/src/service.ts");
type RpcModule = typeof import("../../packages/rpc/src/index.ts");
type TransportModule = typeof import("../../packages/transport/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let filePicker: FilePickerModule;
let rpc: RpcModule;
let transport: TransportModule;
let FakeTransport: new (controller: FakeController) => transport.Transport;

interface FakeController {
  requests: Array<{ path: string; body: unknown }>;
  handler: (path: string, body: unknown) => unknown;
}

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, filePicker, rpc, transport] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<FilePickerModule>("/packages/ui-file-picker/src/service.ts"),
    harness.load<RpcModule>("/packages/rpc/src/index.ts"),
    harness.load<TransportModule>("/packages/transport/src/index.ts"),
  ]);

  FakeTransport = class extends transport.Transport {
    constructor(private readonly controller: FakeController) {
      super();
    }

    override request(path: string, body?: unknown): Promise<unknown> {
      this.controller.requests.push({ path, body });
      return Promise.resolve(this.controller.handler(path, body));
    }

    override async *openStream(): AsyncIterable<unknown> {}

    override childScope() {
      return di.createDescriptor(FakeTransport, this.controller);
    }
  };
});

afterAll(async () => {
  await harness.close();
});

function createService() {
  const controller: FakeController = { requests: [], handler: () => undefined };
  const scope = di.createRootScope();
  scope.provideAll([
    [transport.Transport, di.createDescriptor(FakeTransport, controller)],
    rpc.RpcClientService,
    filePicker.UiFilePickerService,
  ]);
  return {
    scope,
    fake: controller,
    service: scope.get(filePicker.UiFilePickerService),
  };
}

describe("ui file picker", () => {
  it("opens a file session with defaults and resolves its selection", async () => {
    const { scope, service } = createService();
    try {
      const pending = service.pickFile();
      expect(service.activeSession.value).toMatchObject({
        mode: "file",
        title: "Select File",
        confirmLabel: "Select File",
      });

      service.activeSession.value!.resolve("/tmp/a.txt");
      expect(await pending).toBe("/tmp/a.txt");
      expect(service.activeSession.value).toBeNull();
    } finally {
      scope.dispose();
    }
  });

  it("uses folder defaults and honours explicit labels", async () => {
    const { scope, service } = createService();
    try {
      const folder = service.pickFolder();
      expect(service.activeSession.value).toMatchObject({
        mode: "directory",
        title: "Select Folder",
        confirmLabel: "Select Folder",
      });
      service.activeSession.value!.resolve("/tmp");
      expect(await folder).toBe("/tmp");

      const custom = service.pick({
        title: "Choose",
        initialPath: "/tmp/start",
        confirmLabel: "Use it",
      });
      expect(service.activeSession.value).toMatchObject({
        mode: "file",
        title: "Choose",
        initialPath: "/tmp/start",
        confirmLabel: "Use it",
      });
      service.activeSession.value!.resolve(undefined);
      expect(await custom).toBeUndefined();
    } finally {
      scope.dispose();
    }
  });

  it("cancels the previous session when a new pick starts", async () => {
    const { scope, service } = createService();
    try {
      const first = service.pickFile();
      const second = service.pickFolder();
      expect(await first).toBeUndefined();
      expect(service.activeSession.value?.mode).toBe("directory");

      service.activeSession.value!.resolve("/second");
      expect(await second).toBe("/second");
      expect(service.activeSession.value).toBeNull();
    } finally {
      scope.dispose();
    }
  });

  it("round-trips list and createDirectory through the rpc contract", async () => {
    const { scope, service, fake } = createService();
    fake.handler = (path, body) => {
      if (path.endsWith("file-picker.list")) {
        expect(body).toEqual({ path: "/x", includeFiles: false });
        return {
          path: "/x",
          parent: null,
          home: "/home",
          separator: "/",
          entries: [{ name: "a", path: "/x/a", type: "file" }],
          truncated: false,
        };
      }
      expect(path.endsWith("file-picker.createDirectory")).toBe(true);
      expect(body).toEqual({ parentPath: "/x", name: "new" });
      return { path: "/x/new" };
    };
    try {
      const listing = await service.list({ path: "/x", includeFiles: false });
      expect(listing.entries).toEqual([{ name: "a", path: "/x/a", type: "file" }]);
      expect(listing.parent).toBeNull();

      expect(await service.createDirectory("/x", "new")).toBe("/x/new");
      expect(fake.requests.map((request) => request.path)).toEqual([
        "/rpc/file-picker.list",
        "/rpc/file-picker.createDirectory",
      ]);
    } finally {
      scope.dispose();
    }
  });
});
