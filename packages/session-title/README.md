```ts
class SessionTitleService {
  generateTitle(sessionId: string, input: string | readonly ContentBlock[], options?: { readonly signal?: AbortSignal }): void; // 若尚无标题则写入规则占位并异步调用 LLM 生成标题
  rename(sessionId: string, title: string): void; // 手动重命名并中止进行中的自动生成
}
```
