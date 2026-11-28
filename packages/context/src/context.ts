import { inject } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import { LinkedTree, type TreeBranch, type TreeNode } from "@harness/linked-tree";
import { Message } from "@harness/llm";
import {
  deserializeValue,
  ExtensibleFields,
  serializeValue,
  type SerializedVariant,
} from "@harness/variants";
import { effectScope, shallowReactive, watch, watchEffect } from "reactivity";

export class BatchMeta extends ExtensibleFields {}

export interface ContextBatch {
  readonly index: number;
  readonly messages: readonly Message[];
  readonly meta: BatchMeta;
}

interface SerializedBatchPayload {
  readonly messages: readonly SerializedVariant[];
  readonly meta: Record<string, unknown>;
}

function batchMessages(raw: SerializedBatchPayload): Message[] {
  return (raw.messages ?? []).map((item) => Message.deserialize(item));
}

type ContextDataTree = LinkedTree<SerializedBatchPayload, readonly SerializedVariant[]>;

export interface ContextHooks {
  readonly batch: HookSlot<readonly Message[], ContextBatch>;
}

export interface ContextCursor {
  readonly batchIndex: number;
  readonly messageCount?: number;
}

export interface ContextForkOptions {
  readonly id?: string;
  readonly at?: ContextCursor;
}

export interface ContextOptions {
  readonly id?: string;
  readonly initialPending?: readonly Message[];
}

export class Context {
  readonly id: string;
  readonly hooks: ContextHooks = {
    batch: new HookSlot<readonly Message[], ContextBatch>(),
  };
  readonly pending = shallowReactive<Message[]>([]);

  private readonly branch: TreeBranch<SerializedBatchPayload, readonly SerializedVariant[]>;
  private readonly metadataScope = effectScope();
  private readonly batchMetadata = new WeakMap<SerializedBatchPayload, BatchMeta>();

  constructor(options: ContextOptions = {}) {
    this.id = options.id ?? crypto.randomUUID();

    if (options.initialPending && options.initialPending.length > 0) {
      this.pending.push(...options.initialPending);
    }

    const tree = inject(LinkedTree) as ContextDataTree;
    this.branch = tree.branch(this.id, {
      state: this.pending.map((msg) => Message.serialize(msg)),
    });

    if (this.pending.length === 0 && this.branch.state.length > 0) {
      this.pending.push(...this.branch.state.map((item) => Message.deserialize(item)));
    }

    let initialized = false;
    watchEffect(
      () => {
        for (let i = 0; i < this.pending.length; i++) {
          void this.pending[i];
        }
        if (!initialized) {
          initialized = true;
          return;
        }
        this.branch.setState(this.pending.map((msg) => Message.serialize(msg)));
      },
      { flush: "sync" },
    );
  }

  get batchCount(): number {
    return this.branch.head !== null ? this.branch.head.index + 1 : 0;
  }

  batch(): ContextBatch {
    const claimed = this.pending.splice(0);
    return this.hooks.batch.run(claimed, (messages) => {
      const node = this.branch.append(
        { messages: messages.map((msg) => Message.serialize(msg)), meta: {} },
        this.pending.map((msg) => Message.serialize(msg)),
      );
      return {
        index: node.index,
        messages: [...messages],
        meta: this.metaFor(node),
      };
    });
  }

  unbatch(): void {
    const current = this.branch.head;
    if (current === null) {
      throw new Error("no committed batch to unbatch");
    }
    this.pending.unshift(...batchMessages(current.value));
    this.branch.rewind(this.pending.map((msg) => Message.serialize(msg)));
  }

  async *readBackward(): AsyncIterable<ContextBatch> {
    for await (const node of this.branch.readBackward()) {
      yield {
        index: node.index,
        messages: batchMessages(node.value),
        meta: this.metaFor(node),
      };
    }
  }

  private metaFor(node: TreeNode<SerializedBatchPayload>): BatchMeta {
    const cached = this.batchMetadata.get(node.value);
    if (cached) return cached;
    const meta = BatchMeta.deserialize(node.value.meta, deserializeValue);
    this.batchMetadata.set(node.value, meta);
    this.metadataScope.run(() => {
      watch(
        () => BatchMeta.serialize(meta, serializeValue),
        (fields) => {
          const payload = { ...node.value, meta: fields };
          this.branch.updateNode(node, payload);
          this.batchMetadata.set(payload, meta);
        },
        { flush: "sync" },
      );
    });
    return meta;
  }

  async fork(options: ContextForkOptions = {}): Promise<ContextOptions> {
    const id = options.id ?? crypto.randomUUID();
    const at = options.at;
    if (at === undefined) {
      this.branch.fork(id, { state: this.pending.map((msg) => Message.serialize(msg)) });
      return { id };
    }

    const { batchIndex, messageCount } = at;
    if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= this.batchCount) {
      throw new RangeError(`batchIndex ${batchIndex} is out of range [0, ${this.batchCount - 1}]`);
    }

    let targetNode: TreeNode<SerializedBatchPayload> | undefined;
    for await (const node of this.branch.readBackward()) {
      if (node.index === batchIndex) {
        targetNode = node;
        break;
      }
    }
    if (targetNode === undefined) {
      throw new RangeError(`batchIndex ${batchIndex} not found`);
    }

    const count =
      messageCount === undefined
        ? targetNode.value.messages.length
        : Math.max(0, Math.min(messageCount, targetNode.value.messages.length));

    if (count === 0) {
      this.branch.fork(id, { at: await targetNode.parent(), state: [] });
      return { id };
    }

    if (count === targetNode.value.messages.length) {
      this.branch.fork(id, { at: targetNode, state: [] });
      return { id };
    }

    const forked = this.branch.fork(id, { at: await targetNode.parent(), state: [] });
    forked.append(
      {
        messages: targetNode.value.messages.slice(0, count),
        meta: {},
      },
      [],
    );
    return { id };
  }
}
