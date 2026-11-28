```ts
class TreeNode<T> {
  readonly id: string;
  readonly index: number;
  readonly parentId: string | null;
  readonly value: T;
  parent(): Promise<TreeNode<T> | null>; // 从内存获取父节点
  readBackward(): AsyncIterable<TreeNode<T>>; // 从当前节点沿 parent 倒序遍历至根
}

class TreeBranch<T, S = undefined> {
  readonly id: string;
  readonly head: TreeNode<T> | null;
  readonly state: S;
  append(value: T, state: S): TreeNode<T>; // 原子追加新节点并更新 head 与 state
  rewind(state: S): TreeNode<T> | undefined; // 同步回退至 parent 节点（COW，不删原节点）
  setState(state: S): void; // 更新分支状态
  fork(id: string, options: ForkBranchOptions<T, S>): TreeBranch<T, S>; // COW 创建新分支，ID 已存在时抛错
  readBackward(): AsyncIterable<TreeNode<T>>; // 从当前 head 倒序遍历内存节点
  updateNode(node: TreeNode<T>, value: T): void; // 仅更新当前分支中的对应节点；已撤回的节点忽略写入
}

class LinkedTree<T, S = undefined> {
  constructor(options?: LinkedTreeOptions<T, S>);
  branch(id: string, options: BranchOptions<T, S>): TreeBranch<T, S>; // 创建分支
  openBranch(id: string): Promise<TreeBranch<T, S> | undefined>; // 首次打开时恢复历史，损坏的父链会拒绝恢复
}
```
