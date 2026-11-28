import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type LinkedTreeModule = typeof import("../../packages/linked-tree/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let linkedTree: LinkedTreeModule;
let sqlite: SqliteModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, linkedTree, sqlite] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LinkedTreeModule>("/packages/linked-tree/src/index.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
  ]);
});

const tempDirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-linked-tree-"));
  tempDirs.push(dir);
  return join(dir, "tree.db");
}

function openTree(path: string) {
  const scope = di.createRootScope();
  scope.provideAll([di.createDescriptor(sqlite.SqliteService, { path }), linkedTree.LinkedTree]);
  const tree = scope.get(linkedTree.LinkedTree) as InstanceType<LinkedTreeModule["LinkedTree"]>;
  const sqliteService = scope.get(sqlite.SqliteService);
  return {
    scope,
    tree,
    async close() {
      await sqliteService.close();
      scope.dispose();
    },
  };
}

async function values(nodes: AsyncIterable<{ value: unknown }>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const node of nodes) out.push(node.value);
  return out;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("linked tree branches", () => {
  it.each(["missing head", "missing ancestor", "cycle", "invalid index"])(
    "rejects %s before publishing a recovered branch",
    async (corruption) => {
      const path = tempDb();
      const writer = openTree(path);
      const broken = writer.tree.branch("broken", { state: 0 });
      const root = broken.append("root", 1);
      const head = broken.append("head", 2);
      writer.tree.branch("healthy", { state: 0 }).append("kept", 1);
      await writer.close();
      const disk = new DatabaseSync(path);
      try {
        if (corruption === "cycle") {
          disk.prepare("UPDATE tree_nodes SET parent_id = ? WHERE id = ?").run(head.id, root.id);
        } else if (corruption === "invalid index") {
          disk.prepare("UPDATE tree_nodes SET idx = 9 WHERE id = ?").run(head.id);
        } else {
          disk
            .prepare("DELETE FROM tree_nodes WHERE id = ?")
            .run(corruption === "missing head" ? head.id : root.id);
        }
      } finally {
        disk.close();
      }
      const reader = openTree(path);
      try {
        await expect(reader.tree.openBranch("broken")).rejects.toThrow(
          /cycle|missing|parent index/,
        );
        expect(() => reader.tree.branch("broken", { state: 3 })).toThrow();
        expect((await reader.tree.openBranch("healthy"))?.head?.value).toBe("kept");
        const [row] = reader.scope
          .get(sqlite.SqliteService)
          .read<{ head_node_id: string }>(
            "SELECT head_node_id FROM tree_branches WHERE id = 'broken'",
          );
        expect(row?.head_node_id).toBe(head.id);
      } finally {
        await reader.close();
      }
    },
  );

  it("does not replace a fork when its ID is reused after reopening", async () => {
    const dbPath = tempDb();
    const first = openTree(dbPath);
    try {
      const branch = first.tree.branch("parent", { state: 0 });
      branch.append("parent message", 1);
      branch.fork("fork", { state: 2 }).append("fork message", 3);
      expect(() => branch.fork("fork", { state: 4 })).toThrow('Branch "fork" already exists');
    } finally {
      await first.close();
    }

    const reopened = openTree(dbPath);
    try {
      const branch = reopened.tree.branch("parent", { state: 0 });
      expect(() => branch.fork("fork", { state: 5 })).toThrow('Branch "fork" already exists');
      const existing = await reopened.tree.openBranch("fork");
      expect(existing?.state).toBe(3);
      expect(existing?.head?.value).toBe("fork message");
    } finally {
      await reopened.close();
    }
  });

  it("persists successive rewinds through uncached ancestors after reopening", async () => {
    const dbPath = tempDb();
    const first = openTree(dbPath);
    try {
      const branch = first.tree.branch("rewind", { state: 0 });
      branch.append("first", 1);
      branch.append("second", 2);
      branch.append("third", 3);
    } finally {
      await first.close();
    }

    const second = openTree(dbPath);
    try {
      const branch = second.tree.branch("rewind", { state: 0 });
      expect(branch.rewind(2)?.value).toBe("third");
      expect(branch.rewind(1)?.value).toBe("second");
      expect(branch.head?.value).toBe("first");
    } finally {
      await second.close();
    }

    const third = openTree(dbPath);
    try {
      const branch = await third.tree.openBranch("rewind");
      expect(branch?.state).toBe(1);
      expect(await values(branch!.readBackward())).toEqual(["first"]);
    } finally {
      await third.close();
    }
  });

  it("shares one writer between concurrent opens of a persisted branch", async () => {
    const dbPath = tempDb();
    const first = openTree(dbPath);
    try {
      first.tree.branch("concurrent", { state: 0 }).append("first", 1);
    } finally {
      await first.close();
    }

    const second = openTree(dbPath);
    try {
      const [left, right] = await Promise.all([
        second.tree.openBranch("concurrent"),
        second.tree.openBranch("concurrent"),
      ]);
      expect(left).toBeDefined();
      expect(left).toBe(right);
      left!.append("second", 2);
      right!.append("third", 3);
    } finally {
      await second.close();
    }

    const third = openTree(dbPath);
    try {
      const branch = await third.tree.openBranch("concurrent");
      expect(branch?.state).toBe(3);
      expect(await values(branch!.readBackward())).toEqual(["third", "second", "first"]);
    } finally {
      await third.close();
    }
  });

  it("reopens a branch using the default undefined state", async () => {
    const dbPath = tempDb();
    const written = openTree(dbPath);
    try {
      const branch = written.tree.branch("without-state", { state: undefined });
      branch.append("message", undefined);
    } finally {
      await written.close();
    }

    const reopened = openTree(dbPath);
    try {
      const branch = await reopened.tree.openBranch("without-state");
      expect(branch?.state).toBeUndefined();
      expect(branch?.head?.value).toBe("message");
    } finally {
      await reopened.close();
    }
  });

  it("appends, rewinds and forks immutable branches without losing history", async () => {
    const dbPath = tempDb();
    const opened = openTree(dbPath);
    try {
      const main = opened.tree.branch("main", { state: { step: 0 } });
      const a = main.append("a", { step: 1 });
      const b = main.append("b", { step: 2 });
      const c = main.append("c", { step: 3 });

      expect(main.head).toBe(c);
      expect([a.index, b.index, c.index]).toEqual([0, 1, 2]);
      expect(await values(main.readBackward())).toEqual(["c", "b", "a"]);
      expect(main.state).toEqual({ step: 3 });

      const fork = main.fork("fork", { at: b, state: { step: 20 } });
      expect(fork.head).toBe(b);
      expect(fork.state).toEqual({ step: 20 });
      const d = fork.append("d", { step: 21 });
      expect(d.index).toBe(2);
      expect(await values(fork.readBackward())).toEqual(["d", "b", "a"]);
      expect(await values(main.readBackward())).toEqual(["c", "b", "a"]);
      expect(main.state).toEqual({ step: 3 });

      const rewound = main.rewind({ step: 4 });
      expect(rewound).toBe(c);
      expect(main.head).toBe(b);
      expect(main.state).toEqual({ step: 4 });
      expect(main.rewind({ step: 5 })).toBe(b);
      expect(main.rewind({ step: 6 })).toBe(a);
      main.rewind({ step: 7 });
      expect(main.head).toBeNull();
      expect(main.rewind({ step: 8 })).toBeUndefined();
    } finally {
      await opened.close();
    }
  });

  it("loads a long history in pages and exposes parent links", async () => {
    const dbPath = tempDb();
    const first = openTree(dbPath);
    let headId = "";
    try {
      const branch = first.tree.branch("long", { state: 0 });
      for (let i = 0; i < 70; i++) {
        headId = branch.append(`node-${i}`, i + 1).id;
      }
    } finally {
      await first.close();
    }

    const second = openTree(dbPath);
    try {
      const branch = await second.tree.openBranch("long");
      expect(branch).toBeDefined();
      expect(branch!.head!.id).toBe(headId);
      expect(branch!.head!.index).toBe(69);
      expect(branch!.state).toBe(70);

      const reversed = await values(branch!.readBackward());
      expect(reversed).toHaveLength(70);
      expect(reversed[0]).toBe("node-69");
      expect(reversed[69]).toBe("node-0");

      const parent = await branch!.head!.parent();
      expect(parent!.value).toBe("node-68");
      expect(parent!.index).toBe(68);
    } finally {
      await second.close();
    }
  });

  it("persists branch state and node updates across reopen", async () => {
    const dbPath = tempDb();
    const first = openTree(dbPath);
    const branch = first.tree.branch("persisted", { state: { label: "start" } });
    const prefix = branch.append({ text: "prefix" }, { label: "prefix" });
    const a = branch.append({ text: "one" }, { label: "a" });
    const head = branch.append({ text: "two" }, { label: "b" });
    const fork = branch.fork("snapshot", { state: branch.state });
    branch.updateNode(a, { text: "one-updated" });
    const updated = await branch.head!.parent();
    expect(await updated!.parent()).toBe(prefix);
    expect(fork.head).toBe(head);
    expect(await fork.head!.parent()).toBe(a);
    await first.close();

    const second = openTree(dbPath);
    try {
      const branch = await second.tree.openBranch("persisted");
      expect(branch!.state).toEqual({ label: "b" });
      const reversed = await values(branch!.readBackward());
      expect(reversed).toEqual([{ text: "two" }, { text: "one-updated" }, { text: "prefix" }]);
    } finally {
      await second.close();
    }
  });
});
