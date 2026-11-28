```ts
interface AgentsMdFile {
  readonly path: string;
  readonly content: string;
}

class AgentsMdService {
  useSearchDir(dir: string): void; // 在当前 EffectScope 中添加额外目录，按存活注册顺序先于 cwd 祖先目录检查
  discover(cwd?: string): AgentsMdFile[]; // 从额外目录及 cwd 祖先目录发现并读取 AGENTS.override.md / AGENTS.md / CLAUDE.md
}
```
