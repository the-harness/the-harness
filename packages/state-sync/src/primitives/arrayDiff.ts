import { defaultDeserialize, defaultSerialize } from "./codec.ts";

export type ArrayOp<TWire = unknown> =
  | {
      readonly type: "insert";
      readonly id: string;
      readonly beforeId: string | null;
      readonly item: TWire;
    }
  | {
      readonly type: "update";
      readonly id: string;
      readonly item: TWire;
    }
  | {
      readonly type: "move";
      readonly id: string;
      readonly beforeId: string | null;
    }
  | {
      readonly type: "remove";
      readonly id: string;
    };

export interface ArrayPatch<TWire = unknown> {
  readonly opId: string;
  readonly ops: readonly ArrayOp<TWire>[];
}

export interface ArraySyncFrame<TWire = unknown> {
  readonly rev: number;
  readonly ops: readonly ArrayOp<TWire>[];
  readonly opId?: string;
}

export interface ArraySnapshot<TWire = unknown> {
  readonly rev: number;
  readonly items: readonly TWire[];
}

export interface SyncedArrayCodecOptions<T, TWire = unknown> {
  readonly getId?: (item: T) => string;
  readonly serialize?: (item: T) => TWire;
  readonly deserialize?: (raw: TWire, id?: string) => T;
  readonly isEqual?: (a: T, b: T) => boolean;
}

export interface ResolvedCodec<T, TWire> {
  readonly getId: (item: T) => string;
  readonly serialize: (item: T) => TWire;
  readonly deserialize: (raw: TWire, id?: string) => T;
  readonly isEqual: (a: T, b: T) => boolean;
}

export { defaultDeserialize, defaultSerialize };

export function defaultGetId<T>(item: T): string {
  if (
    typeof item === "object" &&
    item !== null &&
    "id" in item &&
    typeof (item as { readonly id: unknown }).id === "string"
  ) {
    return (item as { readonly id: string }).id;
  }
  throw new Error("SyncedArray item must have a string 'id' property or provide getId()");
}

export function resolveCodec<T, TWire = unknown>(
  options: SyncedArrayCodecOptions<T, TWire> = {},
): ResolvedCodec<T, TWire> {
  return {
    getId: options.getId ?? defaultGetId,
    serialize: options.serialize ?? defaultSerialize,
    deserialize: options.deserialize ?? defaultDeserialize,
    isEqual: options.isEqual ?? Object.is,
  };
}

function longestIncreasingSubsequence(seq: readonly number[]): Set<number> {
  const n = seq.length;
  if (n === 0) return new Set();

  const tails: number[] = [];
  const predecessors = Array.from({ length: n }, () => -1);

  for (let i = 0; i < n; i++) {
    const val = seq[i]!;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (seq[tails[mid]!]! < val) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      predecessors[i] = tails[lo - 1]!;
    }
    tails[lo] = i;
  }

  const result = new Set<number>();
  let k = tails[tails.length - 1]!;
  while (k >= 0) {
    result.add(k);
    k = predecessors[k]!;
  }
  return result;
}

export function diffArray<T, TWire = unknown>(
  prev: readonly T[],
  next: readonly T[],
  options?: SyncedArrayCodecOptions<T, TWire>,
): ArrayOp<TWire>[] {
  const { getId, serialize, isEqual } = resolveCodec(options);
  const ops: ArrayOp<TWire>[] = [];

  const prevById = new Map<string, T>();
  for (const item of prev) {
    prevById.set(getId(item), item);
  }

  const nextIds = new Set<string>();
  for (const item of next) {
    nextIds.add(getId(item));
  }

  const survivingPrevIndex = new Map<string, number>();
  let survivingIdx = 0;
  for (const item of prev) {
    const id = getId(item);
    if (!nextIds.has(id)) {
      ops.push({ type: "remove", id });
    } else {
      survivingPrevIndex.set(id, survivingIdx++);
    }
  }

  const survivingNextIds: string[] = [];
  const survivingPositions: number[] = [];
  for (const item of next) {
    const id = getId(item);
    const oldItem = prevById.get(id);
    if (oldItem !== undefined) {
      survivingNextIds.push(id);
      survivingPositions.push(survivingPrevIndex.get(id)!);
      if (!isEqual(oldItem, item)) {
        ops.push({ type: "update", id, item: serialize(item) });
      }
    }
  }

  const lisIndices = longestIncreasingSubsequence(survivingPositions);
  const stationaryIds = new Set<string>();
  for (const idx of lisIndices) {
    stationaryIds.add(survivingNextIds[idx]!);
  }

  let lastStationaryNextIndex = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (stationaryIds.has(getId(next[i]!))) {
      lastStationaryNextIndex = i;
      break;
    }
  }

  for (let i = lastStationaryNextIndex - 1; i >= 0; i--) {
    const item = next[i]!;
    const id = getId(item);
    if (stationaryIds.has(id)) continue;
    const beforeId = getId(next[i + 1]!);
    if (!prevById.has(id)) {
      ops.push({ type: "insert", id, beforeId, item: serialize(item) });
    } else {
      ops.push({ type: "move", id, beforeId });
    }
  }

  for (let i = lastStationaryNextIndex + 1; i < next.length; i++) {
    const item = next[i]!;
    const id = getId(item);
    if (!prevById.has(id)) {
      ops.push({ type: "insert", id, beforeId: null, item: serialize(item) });
    } else {
      ops.push({ type: "move", id, beforeId: null });
    }
  }

  return ops;
}

export function applyArrayOps<T, TWire = unknown>(
  base: readonly T[],
  ops: readonly ArrayOp<TWire>[],
  options?: SyncedArrayCodecOptions<T, TWire>,
): T[] {
  if (ops.length === 0) {
    return [...base];
  }
  const { getId, deserialize } = resolveCodec(options);
  const list = [...base];

  const deserializeItem = (id: string, raw: TWire): T => {
    const item = deserialize(raw, id);
    if (getId(item) !== id) {
      throw new Error(`SyncedArray item ID does not match patch ID: ${id}`);
    }
    return item;
  };

  const findIndexById = (id: string): number => {
    for (let i = 0; i < list.length; i++) {
      if (getId(list[i]!) === id) return i;
    }
    return -1;
  };

  for (const op of ops) {
    switch (op.type) {
      case "remove": {
        const idx = findIndexById(op.id);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
        break;
      }
      case "update": {
        const idx = findIndexById(op.id);
        if (idx !== -1) {
          list[idx] = deserializeItem(op.id, op.item);
        }
        break;
      }
      case "insert": {
        const existingIdx = findIndexById(op.id);
        if (existingIdx !== -1) {
          break;
        }
        const item = deserializeItem(op.id, op.item);
        if (op.beforeId !== null) {
          const anchorIdx = findIndexById(op.beforeId);
          if (anchorIdx !== -1) {
            list.splice(anchorIdx, 0, item);
            break;
          }
        }
        list.push(item);
        break;
      }
      case "move": {
        if (op.beforeId === op.id) break;
        const fromIdx = findIndexById(op.id);
        if (fromIdx === -1) break;
        const [moved] = list.splice(fromIdx, 1);
        if (op.beforeId !== null) {
          const anchorIdx = findIndexById(op.beforeId);
          if (anchorIdx !== -1) {
            list.splice(anchorIdx, 0, moved!);
          } else {
            list.splice(Math.min(fromIdx, list.length), 0, moved!);
          }
        } else {
          list.push(moved!);
        }
        break;
      }
    }
  }

  return list;
}
