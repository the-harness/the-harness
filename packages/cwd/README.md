```ts
class CwdService {
  readonly cwd: string;
  constructor(cwd?: string);
  resolve(filePath: string): string; // 解析相对于 cwd 的路径（支持 ~ 与 @ 前缀）
}
```
