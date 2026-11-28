```ts
interface NotificationOptions {
  message: string;
  severity: "info" | "warning" | "error";
  actions: readonly string[];
  modal?: boolean;
  detail?: string;
  cancelAction?: number; // 模态消息的取消按钮下标
}

interface NotificationMenuContext {
  readonly id?: number; // 非模态通知的 ID；省略时为当前简短提示
  readonly message: string;
}

class UiNotificationService {
  readonly menu: Menu<NotificationMenuContext, "actions">; // 复制消息及关闭通知
  readonly message: Ref<string>; // 当前展示的通知文案
  notify(message: string, durationMs?: number): void; // 展示通知并在指定毫秒后自动消失
  dismiss(): void; // 立即关闭当前通知
  showMessage(options: NotificationOptions, signal?: AbortSignal): Promise<number | undefined>; // 返回选中操作的下标
}
```
