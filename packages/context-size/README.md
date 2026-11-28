```ts
class ContextSizeService {
  estimate(message: Message): number;
  sizeOf(message: Message): number; // 优先返回实测输出 token 数，其次返回（或计算并缓存）估算值
}

useContextSize(): void // 在当前 EffectScope 中记录每条模型回复的实测输出 token 数
```
