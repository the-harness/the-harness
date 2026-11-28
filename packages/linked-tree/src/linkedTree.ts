import { inject } from "@harness/di";
import { SqliteService, type SqliteMutation } from "@harness/sqlite";

export interface LinkedTreeCodec<T, S> {
  serializeValue(value: T): string;
  deserializeValue(raw: string): T;
  serializeState(state: S): string;
  deserializeState(raw: string): S;
}

export interface LinkedTreeOptions<T, S> {
  readonly codec?: LinkedTreeCodec<T, S>;
}

export interface BranchOptions<T, S> {
  readonly head?: TreeNode<T> | null;
  readonly state: S;
}

export interface ForkBranchOptions<T, S> {
  readonly at?: TreeNode<T> | null;
  readonly state: S;
}

interface NodeRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly idx: number;
  readonly value: string;
}

interface BranchRow {
  readonly id: string;
  readonly head_node_id: string | null;
  readonly state: string;
}

const updateBranch =
  "UPDATE tree_branches SET head_node_id = ?, state = ?, updated_at = ? WHERE id = ?";

const defaultCodec: LinkedTreeCodec<any, any> = {
  serializeValue: (value) => JSON.stringify(value),
  deserializeValue: (raw) => JSON.parse(raw),
  serializeState: (state) => (state === undefined ? "" : JSON.stringify(state)),
  deserializeState: (raw) => (raw === "" ? undefined : JSON.parse(raw)),
};

export class TreeNode<T> {
  readonly id: string;
  readonly index: number;
  readonly parentId: string | null;
  readonly value: T;

  protected readonly tree: LinkedTree<T, any>;

  constructor(
    tree: LinkedTree<T, any>,
    data: {
      readonly id: string;
      readonly index: number;
      readonly parentId: string | null;
      readonly value: T;
    },
  ) {
    this.tree = tree;
    this.id = data.id;
    this.index = data.index;
    this.parentId = data.parentId;
    this.value = data.value;
  }

  parent(): Promise<TreeNode<T> | null> {
    if (this.parentId === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.tree.getCachedNode(this.parentId) ?? null);
  }

  readBackward(): AsyncIterable<TreeNode<T>> {
    return this.tree.readBackwardFrom(this.id);
  }
}

export class TreeBranch<T, S = undefined> {
  readonly id: string;

  protected readonly tree: LinkedTree<T, S>;
  protected _head: TreeNode<T> | null;
  protected _state: S;
  private readonly originals = new WeakMap<TreeNode<T>, TreeNode<T>>();

  constructor(tree: LinkedTree<T, S>, id: string, head: TreeNode<T> | null, state: S) {
    this.tree = tree;
    this.id = id;
    this._head = head;
    this._state = state;
  }

  get head(): TreeNode<T> | null {
    return this._head;
  }

  get state(): S {
    return this._state;
  }

  append(value: T, state: S): TreeNode<T> {
    const node = new TreeNode(this.tree, {
      id: crypto.randomUUID(),
      index: (this._head?.index ?? -1) + 1,
      parentId: this._head?.id ?? null,
      value,
    });
    this.tree.commitNodes(this.id, [node], state);
    this._head = node;
    this._state = state;
    return node;
  }

  rewind(state: S): TreeNode<T> | undefined {
    const current = this._head;
    if (current === null) {
      return undefined;
    }
    const parentNode =
      current.parentId !== null ? (this.tree.getCachedNode(current.parentId) ?? null) : null;
    this.tree.persistBranch(this.id, parentNode?.id ?? null, state);
    this._head = parentNode;
    this._state = state;
    return current;
  }

  setState(state: S): void {
    this.tree.persistBranch(this.id, this._head?.id ?? null, state);
    this._state = state;
  }

  fork(id: string, options: ForkBranchOptions<T, S>): TreeBranch<T, S> {
    const targetHead = options.at !== undefined ? options.at : this._head;
    return this.tree.branch(id, { head: targetHead, state: options.state });
  }

  async *readBackward(): AsyncIterable<TreeNode<T>> {
    if (this._head === null) {
      return;
    }
    yield* this._head.readBackward();
  }

  updateNode(node: TreeNode<T>, value: T): void {
    if (this.tree.getCachedNode(node.id) !== node) {
      throw new Error(`Branch "${this.id}" references a node from another tree`);
    }
    const suffix: TreeNode<T>[] = [];
    let current = this._head;
    while (current && current.index > node.index) {
      suffix.push(current);
      current =
        current.parentId === null ? null : (this.tree.getCachedNode(current.parentId) ?? null);
    }
    if (!current || this.originalOf(current) !== this.originalOf(node)) return;

    suffix.push(current);
    let parentId = current.parentId;
    const copies: TreeNode<T>[] = [];
    for (const original of suffix.reverse()) {
      const copy = new TreeNode(this.tree, {
        id: crypto.randomUUID(),
        parentId,
        index: original.index,
        value: original === current ? value : original.value,
      });
      this.originals.set(copy, this.originalOf(original));
      parentId = copy.id;
      copies.push(copy);
    }
    this.tree.commitNodes(this.id, copies, this._state);
    this._head = copies.at(-1)!;
  }

  private originalOf(node: TreeNode<T>): TreeNode<T> {
    return this.originals.get(node) ?? node;
  }
}

export class LinkedTree<T, S = undefined> {
  protected readonly sqlite = inject(SqliteService);
  protected readonly nodes = new Map<string, TreeNode<T>>();
  protected readonly branches = new Map<string, TreeBranch<T, S>>();
  protected readonly codec: LinkedTreeCodec<T, S>;

  constructor(options: LinkedTreeOptions<T, S> = {}) {
    this.codec = options.codec ?? defaultCodec;

    this.sqlite.createTable(
      "tree_nodes",
      `
      id TEXT PRIMARY KEY, parent_id TEXT, idx INTEGER NOT NULL,
      value TEXT NOT NULL, created_at INTEGER NOT NULL
    `,
    );
    this.sqlite.createTable(
      "tree_branches",
      `
      id TEXT PRIMARY KEY, head_node_id TEXT, state TEXT NOT NULL, updated_at INTEGER NOT NULL
    `,
    );
  }

  branch(id: string, options: BranchOptions<T, S>): TreeBranch<T, S> {
    const existing = this.restoreBranch(id);
    if (existing) {
      if (options.head === undefined) return existing;
      throw new Error(`Branch "${id}" already exists`);
    }
    const head = options.head ?? null;
    if (head && this.nodes.get(head.id) !== head) {
      throw new Error(`Branch "${id}" references a node from another tree`);
    }
    const branch = new TreeBranch(this, id, head, options.state);
    this.sqlite.write(() => [
      [
        "INSERT INTO tree_branches (id, head_node_id, state, updated_at) VALUES (?, ?, ?, ?)",
        id,
        head?.id ?? null,
        this.codec.serializeState(options.state),
        Date.now(),
      ],
    ]);
    this.branches.set(id, branch);
    return branch;
  }

  async openBranch(id: string): Promise<TreeBranch<T, S> | undefined> {
    return this.restoreBranch(id);
  }

  private restoreBranch(id: string): TreeBranch<T, S> | undefined {
    const existing = this.branches.get(id);
    if (existing) return existing;
    const [row] = this.sqlite.read<BranchRow>(
      "SELECT id, head_node_id, state FROM tree_branches WHERE id = ?",
      id,
    );
    if (!row) return undefined;
    if (row.head_node_id !== null && !this.nodes.has(row.head_node_id)) {
      const history = this.sqlite.read<NodeRow>(
        `
        WITH RECURSIVE chain(id, parent_id, idx, value) AS (
          SELECT id, parent_id, idx, value FROM tree_nodes WHERE id = ?
          UNION
          SELECT n.id, n.parent_id, n.idx, n.value FROM tree_nodes n JOIN chain ON n.id = chain.parent_id
        )
        SELECT * FROM chain
      `,
        row.head_node_id,
      );
      const rows = new Map(history.map((item) => [item.id, item]));
      const restored = new Map<string, TreeNode<T>>();
      let current: string | null = row.head_node_id;
      while (current !== null && !this.nodes.has(current)) {
        if (restored.has(current))
          throw new Error(`Branch "${id}" has a cycle at node "${current}"`);
        const item = rows.get(current);
        if (!item) throw new Error(`Branch "${id}" references missing node "${current}"`);
        restored.set(current, this.rowToNode(item));
        current = item.parent_id;
      }
      for (const node of restored.values()) {
        const parent =
          node.parentId === null
            ? undefined
            : (restored.get(node.parentId) ?? this.nodes.get(node.parentId));
        if (node.index !== (parent?.index ?? -1) + 1) {
          throw new Error(`Branch "${id}" has an invalid parent index at node "${node.id}"`);
        }
      }
      for (const [nodeId, node] of restored) this.nodes.set(nodeId, node);
    }
    const head = row.head_node_id === null ? null : (this.nodes.get(row.head_node_id) ?? null);
    const branch = new TreeBranch(this, id, head, this.codec.deserializeState(row.state));
    this.branches.set(id, branch);
    return branch;
  }

  /** @internal */
  getCachedNode(id: string): TreeNode<T> | undefined {
    return this.nodes.get(id);
  }

  /** @internal */
  commitNodes(branchId: string, nodes: readonly TreeNode<T>[], state: S): void {
    this.sqlite.write(() => {
      const now = Date.now();
      const writes = nodes.map((node): SqliteMutation => [
        "INSERT INTO tree_nodes (id, parent_id, idx, value, created_at) VALUES (?, ?, ?, ?, ?)",
        node.id,
        node.parentId,
        node.index,
        this.codec.serializeValue(node.value),
        now,
      ]);
      writes.push([
        updateBranch,
        nodes.at(-1)!.id,
        this.codec.serializeState(state),
        now,
        branchId,
      ]);
      return writes;
    });
    for (const node of nodes) this.nodes.set(node.id, node);
  }

  /** @internal */
  persistBranch(branchId: string, headNodeId: string | null, state: S): void {
    this.sqlite.write(() => [
      [updateBranch, headNodeId, this.codec.serializeState(state), Date.now(), branchId],
    ]);
  }

  /** @internal */
  async *readBackwardFrom(fromId: string): AsyncIterable<TreeNode<T>> {
    let node = this.nodes.get(fromId);
    while (node) {
      yield node;
      node = node.parentId === null ? undefined : this.nodes.get(node.parentId);
    }
  }

  protected rowToNode(row: NodeRow): TreeNode<T> {
    return new TreeNode<T>(this, {
      id: row.id,
      index: row.idx,
      parentId: row.parent_id,
      value: this.codec.deserializeValue(row.value),
    });
  }
}
