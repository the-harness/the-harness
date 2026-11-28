import { beforeAll, describe, expect, it } from "vite-plus/test";
import type { ArrayOp } from "../../packages/state-sync/src/index.ts";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type StateSyncModule = typeof import("../../packages/state-sync/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let sync: StateSyncModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, sync] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<StateSyncModule>("/packages/state-sync/src/index.ts"),
  ]);
});

interface Item {
  readonly id: string;
  readonly label: string;
}

function item(id: string, label = id): Item {
  return { id, label };
}

const codec = { isEqual: (a: Item, b: Item) => a.id === b.id && a.label === b.label };

function roundTrip(prev: readonly Item[], next: readonly Item[]): ArrayOp<Item>[] {
  const ops = sync.diffArray<Item, Item>(prev, next, codec);
  expect(sync.applyArrayOps(prev, ops, codec)).toEqual(next);
  return ops;
}

describe("array diff", () => {
  it("applies removes, updates, insertions and moves to reproduce the next array", () => {
    const prev = [item("a"), item("b"), item("c")];
    const next = [item("c"), item("a", "a-updated"), item("d")];

    const ops = roundTrip(prev, next);
    expect(ops.filter((op) => op.type === "remove")).toEqual([{ type: "remove", id: "b" }]);
    expect(ops.filter((op) => op.type === "update")).toEqual([
      { type: "update", id: "a", item: item("a", "a-updated") },
    ]);
    expect(ops.filter((op) => op.type === "insert")).toEqual([
      { type: "insert", id: "d", beforeId: null, item: item("d") },
    ]);
    expect(ops.filter((op) => op.type === "move")).toEqual([
      { type: "move", id: "c", beforeId: "a" },
    ]);
  });

  it("moves only the elements outside the longest increasing subsequence", () => {
    const ops = roundTrip(
      [item("a"), item("b"), item("c"), item("d")],
      [item("a"), item("c"), item("b"), item("d")],
    );
    expect(ops).toEqual([{ type: "move", id: "c", beforeId: "b" }]);

    const reversed = sync.diffArray<Item, Item>(
      [item("a"), item("b"), item("c")],
      [item("c"), item("b"), item("a")],
      codec,
    );
    expect(reversed.filter((op) => op.type === "move")).toHaveLength(2);
    expect(sync.applyArrayOps([item("a"), item("b"), item("c")], reversed, codec)).toEqual([
      item("c"),
      item("b"),
      item("a"),
    ]);
  });

  it("treats insert and remove operations as idempotent", () => {
    const base = [item("a")];
    const add = [{ type: "insert" as const, id: "b", beforeId: "a", item: item("b") }];
    expect(sync.applyArrayOps(base, add, codec)).toEqual([item("b"), item("a")]);
    expect(sync.applyArrayOps(sync.applyArrayOps(base, add, codec), add, codec)).toEqual([
      item("b"),
      item("a"),
    ]);

    const remove = [{ type: "remove" as const, id: "missing" }];
    expect(sync.applyArrayOps(base, remove, codec)).toEqual([item("a")]);
    expect(
      sync.applyArrayOps(base, [{ type: "move", id: "missing", beforeId: null }], codec),
    ).toEqual([item("a")]);
  });

  it("supports explicit ids and wire codecs", () => {
    interface Wire {
      readonly key: string;
      readonly text: string;
    }
    interface Model {
      readonly key: string;
      readonly text: string;
    }
    const modelCodec = {
      getId: (value: Model) => value.key,
      serialize: (value: Model): Wire => ({ key: value.key, text: value.text.toUpperCase() }),
      deserialize: (wire: Wire): Model => ({ key: wire.key, text: wire.text.toLowerCase() }),
      isEqual: (a: Model, b: Model) => a.key === b.key && a.text === b.text,
    };
    const prev: Model[] = [{ key: "a", text: "one" }];
    const next: Model[] = [
      { key: "b", text: "two" },
      { key: "a", text: "ONE" },
    ];

    const ops = sync.diffArray(prev, next, modelCodec);
    expect(ops).toContainEqual({
      type: "insert",
      id: "b",
      beforeId: "a",
      item: { key: "b", text: "TWO" },
    });
    expect(sync.applyArrayOps(prev, ops, modelCodec)).toEqual([
      { key: "b", text: "two" },
      { key: "a", text: "one" },
    ]);
    expect(() => sync.diffArray([{ key: "a" }], [{ key: "b" }])).toThrow(
      "SyncedArray item must have a string 'id' property or provide getId()",
    );
  });
});

describe("SyncedArrayHost", () => {
  it("emits one frame per local mutation and exposes a wire snapshot", () => {
    const owner = di.createRootScope();
    const host = owner.run(() => new sync.SyncedArrayHost([item("a")], codec))!;
    const frames: unknown[] = [];
    const unsubscribe = host.subscribe((frame) => frames.push(frame));
    try {
      host.items.push(item("b"));
      host.items[0] = item("a", "updated");
      host.items.splice(0, 1);

      expect(host.rev).toBe(3);
      expect(frames).toEqual([
        {
          rev: 1,
          ops: [{ type: "insert", id: "b", beforeId: null, item: item("b") }],
        },
        {
          rev: 2,
          ops: [{ type: "update", id: "a", item: item("a", "updated") }],
        },
        { rev: 3, ops: [{ type: "remove", id: "a" }] },
      ]);
      expect(host.snapshot()).toEqual({ rev: 3, items: [item("b")] });
    } finally {
      unsubscribe();
      owner.dispose();
    }
  });

  it("normalizes remote patches, broadcasts them and drops duplicate applications", () => {
    const owner = di.createRootScope();
    const host = owner.run(() => new sync.SyncedArrayHost([item("a")], codec))!;
    const frames: { rev: number; opId?: string; ops: readonly unknown[] }[] = [];
    host.subscribe((frame) => frames.push(frame));
    try {
      const first = host.apply({
        opId: "p1",
        ops: [{ type: "insert", id: "b", beforeId: "a", item: item("b") }],
      });
      expect(first).toEqual({
        rev: 1,
        opId: "p1",
        ops: [{ type: "insert", id: "b", beforeId: "a", item: item("b") }],
      });
      expect(host.items).toEqual([item("b"), item("a")]);

      const duplicate = host.apply({
        opId: "p2",
        ops: [{ type: "insert", id: "b", beforeId: "a", item: item("b") }],
      });
      expect(duplicate).toEqual({ rev: 1, opId: "p2", ops: [] });
      expect(host.items).toEqual([item("b"), item("a")]);
      expect(frames.map((frame) => frame.rev)).toEqual([1, 1]);
    } finally {
      owner.dispose();
    }
  });

  it("stops emitting and ignores patches after disposal", () => {
    const owner = di.createRootScope();
    const host = owner.run(() => new sync.SyncedArrayHost([item("a")], codec))!;
    const frames: unknown[] = [];
    host.subscribe((frame) => frames.push(frame));
    owner.dispose();

    host.items.push(item("b"));
    const applied = host.apply({
      opId: "p1",
      ops: [{ type: "insert", id: "c", beforeId: null, item: item("c") }],
    });

    expect(frames).toEqual([]);
    expect(host.apply({ opId: "p2", ops: [] })).toEqual({ rev: 0, opId: "p2", ops: [] });
    expect(host.snapshot()).toEqual({ rev: 0, items: [item("a"), item("b")] });
    expect(applied.rev).toBe(0);
    expect(host.subscribe(() => {})).not.toThrow();
  });
});

describe("SyncedArrayClient", () => {
  it("round-trips local edits to the host and host edits back to the client", () => {
    const owner = di.createRootScope();
    const host = owner.run(() => new sync.SyncedArrayHost([item("a")], codec))!;
    const client = owner.run(
      () => new sync.SyncedArrayClient<Item>({ ...codec, initialItems: [item("stale")] }),
    )!;
    const disconnect = host.connect(client);
    try {
      expect(client.items).toEqual([item("a")]);
      expect(client.rev).toBe(0);

      client.items.push(item("b"));
      expect(host.items).toEqual([item("a"), item("b")]);
      expect(client.items).toEqual([item("a"), item("b")]);
      expect(client.rev).toBe(1);
      expect(client.pendingCount).toBe(0);

      host.items.unshift(item("c"));
      expect(client.items).toEqual([item("c"), item("a"), item("b")]);
      expect(client.rev).toBe(2);
    } finally {
      disconnect();
      owner.dispose();
    }
  });

  it("replays queued local edits over a newer server snapshot on reconnect", () => {
    const owner = di.createRootScope();
    const host = owner.run(() => new sync.SyncedArrayHost([item("a")], codec))!;
    const client = owner.run(
      () => new sync.SyncedArrayClient<Item>({ ...codec, initialItems: [item("a")] }),
    )!;
    try {
      client.items.push(item("local"));
      client.items.unshift(item("first"));
      expect(client.pendingCount).toBe(2);

      host.items.push(item("remote"));
      const disconnect = host.connect(client);
      try {
        expect(client.items).toEqual([item("first"), item("a"), item("remote"), item("local")]);
        expect(host.items).toEqual(client.items);
        expect(client.pendingCount).toBe(0);
      } finally {
        disconnect();
      }
    } finally {
      owner.dispose();
    }
  });

  it("reverts an optimistic edit when the sender rejects it", async () => {
    const owner = di.createRootScope();
    const client = owner.run(
      () =>
        new sync.SyncedArrayClient<Item>({
          ...codec,
          initialItems: [item("a")],
          send: () => Promise.reject(new Error("offline")),
        }),
    )!;
    try {
      client.items.push(item("b"));
      expect(client.items).toEqual([item("a"), item("b")]);
      expect(client.pendingCount).toBe(1);

      await Promise.resolve();
      await Promise.resolve();

      expect(client.items).toEqual([item("a")]);
      expect(client.pendingCount).toBe(0);
    } finally {
      owner.dispose();
    }
  });

  it("ignores stale frames and applies newer frames with their ops", () => {
    const owner = di.createRootScope();
    const client = owner.run(
      () => new sync.SyncedArrayClient<Item>({ ...codec, initialItems: [item("a")] }),
    )!;
    try {
      client.receive({
        rev: 1,
        ops: [{ type: "insert", id: "b", beforeId: null, item: item("b") }],
      });
      expect(client.items).toEqual([item("a"), item("b")]);
      expect(client.rev).toBe(1);

      client.receive({ rev: 1, ops: [{ type: "remove", id: "a" }] });
      expect(client.items).toEqual([item("a"), item("b")]);

      client.receive({ rev: 2, ops: [{ type: "remove", id: "a" }] });
      expect(client.items).toEqual([item("b")]);
      expect(client.rev).toBe(2);
    } finally {
      owner.dispose();
    }
  });

  it("serializes custom codecs across the host/client boundary", () => {
    const owner = di.createRootScope();
    interface Wire {
      readonly id: string;
      readonly text: string;
    }
    interface Doc {
      readonly id: string;
      readonly text: string;
    }
    const docCodec = {
      getId: (doc: Doc) => doc.id,
      serialize: (doc: Doc): Wire => ({ id: doc.id, text: doc.text.toUpperCase() }),
      deserialize: (wire: Wire): Doc => ({ id: wire.id, text: wire.text.toLowerCase() }),
      isEqual: (a: Doc, b: Doc) => a.id === b.id && a.text === b.text,
    };

    const host = owner.run(
      () => new sync.SyncedArrayHost<Doc, Wire>([{ id: "a", text: "one" }], docCodec),
    )!;
    const client = owner.run(
      () => new sync.SyncedArrayClient<Doc, Wire>({ ...docCodec, initialItems: [] }),
    )!;
    host.connect(client);
    try {
      expect(host.snapshot()).toEqual({ rev: 0, items: [{ id: "a", text: "ONE" }] });
      expect(client.items).toEqual([{ id: "a", text: "one" }]);

      client.items.push({ id: "b", text: "two" });
      expect(host.items).toEqual([
        { id: "a", text: "one" },
        { id: "b", text: "two" },
      ]);
      expect(client.items).toEqual(host.items);
    } finally {
      owner.dispose();
    }
  });
});
