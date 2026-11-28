```ts
interface SqliteServiceOptions {
  readonly path: string; // SQLite 文件路径或 ":memory:"
}

type SqliteMutation = readonly [sql: string, ...values: SQLInputValue[]]; // 每项对应一条 SQL 写语句

class SqliteService {
  constructor(options: SqliteServiceOptions);
  createTable(name: string, definition: string): void; // 初始化业务表结构
  write(prepare: () => readonly SqliteMutation[]): void; // 在 prepare 内构造 SQL 和参数快照。同一同步段原子提交，任一写入失败即停止后续提交
  read<Row = Record<string, SQLOutputValue>>(sql: string, ...values: SQLInputValue[]): Row[]; // 查询已提交数据，不等待写队列
  flush(): Promise<void>; // 等待调用时已受理的批次落盘，该批次入队或提交失败时拒绝
  close(): Promise<void>; // 停止受理，等待待写批次并关闭连接
}
```
