import {
  computed,
  getCurrentScope,
  onScopeDispose,
  reactive,
  ref,
  shallowReactive,
  type ComputedRef,
  type Ref,
} from "vue";
import { createOutputMenu } from "./menus.ts";

export type { OutputMenuContext } from "./menus.ts";

export interface OutputChannelGroup {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface OutputChannel {
  readonly id: string;
  readonly name: string;
  readonly group?: OutputChannelGroup;
  readonly lines: readonly string[];
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
}

export class UiOutputService {
  readonly menu = createOutputMenu((id) => this.channelMap.get(id));
  private readonly channelMap = shallowReactive(new Map<string, OutputChannel>());
  private disposed = false;
  readonly activeChannelId: Ref<string | null> = ref(null);

  readonly channels: ComputedRef<readonly OutputChannel[]> = computed(() =>
    Array.from(this.channelMap.values()),
  );

  constructor() {
    onScopeDispose(() => {
      this.disposed = true;
      this.channelMap.clear();
      this.activeChannelId.value = null;
    });
  }

  useChannel(name: string, group?: OutputChannelGroup, identity?: string): OutputChannel {
    if (this.disposed) throw new Error("UiOutputService is disposed");
    if (!getCurrentScope()?.active) {
      throw new Error("useChannel() requires an active EffectScope");
    }
    const id = JSON.stringify(
      identity === undefined ? [group?.id ?? null, name] : [group?.id ?? null, name, identity],
    );
    if (this.channelMap.has(id)) {
      throw new Error(`Output channel '${name}' already exists`);
    }

    const lines = reactive<string[]>([]);
    const append = (value: string) => {
      const segments = value.split("\n");
      const tail = lines.length - 1;
      if (tail < 0) lines.push(segments[0]!);
      else lines[tail] += segments[0]!;
      for (const segment of segments.slice(1)) lines.push(segment);
    };
    const channel: OutputChannel = {
      id,
      name,
      group,
      lines,
      append,
      appendLine(value: string) {
        append(`${value}\n`);
      },
      clear() {
        lines.length = 0;
      },
    };

    onScopeDispose(() => {
      if (this.channelMap.get(id) !== channel) return;
      this.channelMap.delete(id);
      if (this.activeChannelId.value === id && !this.channelMap.has(id)) {
        this.activeChannelId.value = this.channels.value[0]?.id ?? null;
      }
    });
    this.channelMap.set(id, channel);
    if (this.channelMap.get(id) === channel && !this.activeChannelId.value) {
      this.activeChannelId.value = id;
    }
    return channel;
  }
}

export { default as OutputPanel } from "./panels/OutputPanel.vue";
