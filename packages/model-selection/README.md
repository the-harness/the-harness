```ts
interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoning?: boolean | string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

class ModelSelectionService {
  current: ModelSelection; // 响应式（shallowRef）的当前模型及推理参数选择
  constructor(initial?: ModelSelection);
  select(selection: ModelSelection): void; // 更新当前模型选择
}
```
