import { TabDescriptor } from "@harness/ui-workbench";
import { variant } from "@harness/variants";

@variant("harness:web:webview")
export class WebviewTabDescriptor extends TabDescriptor {
  static override readonly kind = "webview";
  readonly webviewId: string;
  readonly title: string;

  constructor(input: { webviewId: string; title: string; pinned?: boolean }) {
    super(input);
    this.webviewId = input.webviewId;
    this.title = input.title;
  }

  get key(): string {
    return `webview:${this.webviewId}`;
  }

  get defaultTitle(): string {
    return this.title;
  }
}
