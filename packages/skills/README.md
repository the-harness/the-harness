```ts
interface Skill {
  readonly name: string;
  readonly description: string;
  readonly location: string;
}

class SkillsService {
  useRoot(dir: string): void; // 在当前 EffectScope 中注册额外扫描根目录，后注册且存活的根目录优先
  discover(): Skill[]; // 扫描标准目录（~/.agents/skills、<cwd>/.agents/skills）与已注册根目录中的 SKILL.md / *.md
  get(name: string): Skill | undefined; // 按名称查找已发现的 skill
}
```
