import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { StorageLike } from "@vueuse/core";
import { createMainThreadAuthentication } from "../../packages/vscode-ext-host/src/main-thread/authentication.ts";
import { createMainThreadWorkspace } from "../../packages/vscode-ext-host/src/main-thread/workspace.ts";
import { findWorkspaceFiles } from "../../packages/vscode-ext-host/src/node/file-search.ts";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type WorkspaceNodeModule = typeof import("../../packages/ui-workspace/src/node.ts");
type StorageModule = typeof import("../../packages/ui-storage/src/storage.ts");
type ConfigModule = typeof import("../../packages/ui-config/src/index.ts");
type ReactivityModule = typeof import("reactivity");

let harness: HarnessModules;
let di: DiModule;
let workspaceNode: WorkspaceNodeModule;
let storageModule: StorageModule;
let configModule: ConfigModule;
let reactivity: ReactivityModule;
let tempDir: string;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, workspaceNode, storageModule, configModule, reactivity] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<WorkspaceNodeModule>("/packages/ui-workspace/src/node.ts"),
    harness.load<StorageModule>("/packages/ui-storage/src/storage.ts"),
    harness.load<ConfigModule>("/packages/ui-config/src/index.ts"),
    harness.load<ReactivityModule>("reactivity"),
  ]);
  tempDir = mkdtempSync(join(tmpdir(), "harness-main-thread-"));
});

afterAll(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await harness.close();
});

interface ScopeHandle {
  readonly root: string;
  readonly handler: (method: string, args: unknown[]) => Promise<unknown>;
  readonly scope: di.Scope;
}

function createWorkspaceHandler(options: { storage?: StorageLike } = {}): ScopeHandle {
  const root = mkdtempSync(join(tempDir, "workspace-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const scope = di.createRootScope();
  scope.provideAll([
    options.storage
      ? di.createDescriptor(storageModule.UiStorageService, { localStorage: options.storage })
      : storageModule.UiStorageService,
    configModule.UiConfigService,
    workspaceNode.WorkspaceFsService,
  ]);
  const fs = scope.get(workspaceNode.WorkspaceFsService);
  const config = scope.get(configModule.UiConfigService);
  const roots: string[] = [root];
  const workspace = {
    activeRoots: reactivity.computed(() => roots),
    getRoot: () => ({
      readFile: (relativePath: string) => fs.readFile(root, relativePath),
      writeFile: (relativePath: string, content: string) =>
        fs.writeFile(root, relativePath, content),
      loadDir: (relativePath: string) => fs.readDir(root, relativePath),
      createDir: (relativePath: string) => fs.createDir(root, relativePath),
      deletePath: (relativePath: string) => fs.deletePath(root, relativePath),
      renamePath: (from: string, to: string) => fs.renamePath(root, from, to),
    }),
  };
  return {
    root,
    scope,
    handler: createMainThreadWorkspace(workspace as never, config),
  };
}

describe("main thread workspace bridge", () => {
  it("reads, writes, lists, renames and deletes real workspace files", async () => {
    const opened = createWorkspaceHandler();
    try {
      const { handler, root } = opened;
      await handler("workspace.writeFile", [join(root, "src/app.ts"), "export const value = 1;\n"]);
      expect(readFileSync(join(root, "src/app.ts"), "utf-8")).toBe("export const value = 1;\n");
      expect(await handler("workspace.readFile", [join(root, "src/app.ts")])).toBe(
        "export const value = 1;\n",
      );

      await handler("workspace.createDirectory", [join(root, "notes")]);
      expect(statSync(join(root, "notes")).isDirectory()).toBe(true);
      await handler("workspace.writeFile", [join(root, "notes/todo.md"), "# todo"]);
      const listing = (await handler("workspace.readDirectory", [root])) as Array<[string, number]>;
      expect(listing).toEqual(
        expect.arrayContaining([
          ["notes", 2],
          ["src", 2],
        ]),
      );
      expect(listing).not.toContainEqual(["todo.md", 1]);

      await handler("workspace.rename", [join(root, "notes/todo.md"), join(root, "notes/done.md")]);
      expect(readFileSync(join(root, "notes/done.md"), "utf-8")).toBe("# todo");
      expect(() => readFileSync(join(root, "notes/todo.md"))).toThrow();

      const document = await handler("workspace.openTextDocument", [join(root, "notes/done.md")]);
      expect(document).toMatchObject({
        uri: { scheme: "file", path: join(root, "notes/done.md") },
        text: "# todo",
        version: 1,
        languageId: "plaintext",
        isDirty: false,
      });

      await handler("workspace.delete", [join(root, "notes/done.md")]);
      expect(() => readFileSync(join(root, "notes/done.md"))).toThrow();
    } finally {
      opened.scope.dispose();
    }
  });

  it("rejects paths outside the active workspace roots without touching disk", async () => {
    const opened = createWorkspaceHandler();
    try {
      const { handler, root } = opened;
      const sibling = `${root}-sibling`;
      writeFileSync(sibling, "outside");
      try {
        await expect(handler("workspace.writeFile", [sibling, "hacked"])).rejects.toThrow(
          "outside active workspace roots",
        );
        expect(readFileSync(sibling, "utf-8")).toBe("outside");
        await expect(handler("workspace.readFile", ["/etc/passwd"])).rejects.toThrow(
          "outside active workspace roots",
        );
        await expect(handler("workspace.readFile", [`${root}/../escape.txt`])).rejects.toThrow(
          "Path escapes workspace root",
        );
        await expect(handler("workspace.delete", [root])).rejects.toThrow(
          "Cannot delete workspace root",
        );
      } finally {
        rmSync(sibling, { force: true });
      }
    } finally {
      opened.scope.dispose();
    }
  });

  it("finds files by glob with a result limit and reads workspace configuration", async () => {
    const opened = createWorkspaceHandler();
    try {
      const { handler, root } = opened;
      writeFileSync(join(root, "a.ts"), "alpha\n");
      writeFileSync(join(root, "b.ts"), "beta\n");
      writeFileSync(join(root, "c.md"), "# c\n");
      writeFileSync(join(root, "src/nested.ts"), "nested\n");

      const config = opened.scope.get(configModule.UiConfigService);
      const tsFiles = (await findWorkspaceFiles([root], ["*.ts"], {}, config)).map(
        (uri) => uri.fsPath,
      );
      expect(tsFiles).toEqual(expect.arrayContaining([join(root, "a.ts"), join(root, "b.ts")]));
      expect(tsFiles).not.toContain(join(root, "src/nested.ts"));

      const limited = await findWorkspaceFiles([root], ["*.ts"], { maxResults: 1 }, config);
      expect(limited).toHaveLength(1);

      expect(await handler("workspace.getConfig", ["demo.greeting", "fallback"])).toBe("fallback");
      await handler("workspace.updateConfig", ["demo.greeting", "workspace", "workspace"]);
      expect(await handler("workspace.getConfig", ["demo.greeting"])).toBe("workspace");
      await handler("workspace.updateConfig", ["demo.greeting", undefined, "workspace"]);
      expect(await handler("workspace.getConfig", ["demo.greeting", "fallback"])).toBe("fallback");
    } finally {
      opened.scope.dispose();
    }
  });

  it("searches file text case-insensitively and as a regular expression", async () => {
    const opened = createWorkspaceHandler();
    try {
      const { handler, root } = opened;
      writeFileSync(join(root, "one.txt"), "Alpha\nbeta\n");
      writeFileSync(join(root, "two.txt"), "alpha gamma\n");

      const insensitive = (await handler("workspace.findTextInFiles", [
        { pattern: "alpha", isCaseSensitive: false },
      ])) as { hits: Array<{ path: string; line: number; text: string }>; limitHit: boolean };
      expect(insensitive.hits).toHaveLength(2);
      expect(insensitive.hits.map((hit) => hit.text).sort()).toEqual(["Alpha", "alpha gamma"]);

      const sensitive = (await handler("workspace.findTextInFiles", [
        { pattern: "alpha", isCaseSensitive: true },
      ])) as { hits: Array<{ path: string; line: number; text: string }>; limitHit: boolean };
      expect(sensitive.hits).toHaveLength(1);
      expect(sensitive.hits[0]).toMatchObject({ path: join(root, "two.txt"), line: 0 });

      const regex = (await handler("workspace.findTextInFiles", [
        { pattern: "a\\w+", isRegExp: true, isCaseSensitive: false },
      ])) as { hits: Array<{ text: string }>; limitHit: boolean };
      expect(regex.hits.map((hit) => hit.text).sort()).toEqual([
        "Alpha",
        "alpha gamma",
        "alpha gamma",
      ]);
    } finally {
      opened.scope.dispose();
    }
  });
});

interface QuickPickRequest {
  readonly items: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  readonly options?: { readonly title?: string };
}

class DeferredQuickInput {
  readonly requests: QuickPickRequest[] = [];
  private resolve: ((value: unknown) => void) | null = null;

  showQuickPick(
    items: QuickPickRequest["items"],
    options?: QuickPickRequest["options"],
  ): Promise<unknown> {
    this.requests.push({ items, options });
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  settle(value: unknown): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(value);
  }
}

async function createSecretStorage(path: string) {
  const [sqlite, secretStorage] = await Promise.all([
    harness.load<typeof import("../../packages/sqlite/src/index.ts")>(
      "/packages/sqlite/src/index.ts",
    ),
    harness.load<typeof import("../../packages/secret-storage/src/index.ts")>(
      "/packages/secret-storage/src/index.ts",
    ),
  ]);
  const scope = di.createRootScope();
  scope.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path }),
    di.createDescriptor(secretStorage.SecretStorageService, {
      profileId: "fixture",
      key: new Uint8Array(32),
    }),
  ]);
  return {
    service: scope.get(secretStorage.SecretStorageService),
    async dispose() {
      await scope.get(sqlite.SqliteService).close();
      scope.dispose();
    },
  };
}

describe("main thread authentication bridge", () => {
  it("rejects unknown authentication providers without inventing credentials", async () => {
    const quickInput = new DeferredQuickInput();
    const auth = createMainThreadAuthentication(quickInput as never);
    await expect(auth("auth.getSession", ["github", ["repo"]])).rejects.toThrow(
      "No authentication provider",
    );
    await expect(
      auth("auth.getSession", ["github", ["repo"], { createIfNone: true }]),
    ).rejects.toThrow("No authentication provider");
    expect(quickInput.requests).toHaveLength(0);
  });

  it("stores, reads and deletes secrets through the persisted storage", async () => {
    const path = join(tempDir, "secrets.db");
    const first = await createSecretStorage(path);
    const token = "secret-token";
    try {
      await first.service.store("audit.github", "token", token);
      expect(await first.service.get("audit.github", "token")).toBe(token);
    } finally {
      await first.dispose();
    }
    const second = await createSecretStorage(path);
    try {
      expect(await second.service.get("audit.github", "token")).toBe(token);
      await second.service.delete("audit.github", "token");
      expect(await second.service.get("audit.github", "token")).toBeUndefined();
      await second.service.delete("audit.github", "missing");
    } finally {
      await second.dispose();
    }
  });

  it("keeps authentication state isolated between storage instances", async () => {
    const first = await createSecretStorage(":memory:");
    const second = await createSecretStorage(":memory:");
    try {
      await first.service.store("audit.github", "token", "first");
      expect(await first.service.get("audit.github", "token")).toBe("first");
      expect(await second.service.get("audit.github", "token")).toBeUndefined();
      await second.service.store("audit.github", "token", "second");
      expect(await first.service.get("audit.github", "token")).toBe("first");
      expect(await second.service.get("audit.github", "token")).toBe("second");
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });
});
