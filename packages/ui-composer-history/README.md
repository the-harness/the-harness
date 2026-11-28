```ts
class UiComposerHistoryService {
  navigateOlder(caret: number): number | null; // 以注入的 UiChatService 草稿为当前位置；返回新的光标位置，null 表示该按键交给编辑器
  navigateNewer(caret: number): number | null;
}
```
