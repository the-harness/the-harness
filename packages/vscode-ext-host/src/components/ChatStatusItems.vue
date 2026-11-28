<script setup lang="ts">
import { computed, defineComponent, h, reactive } from "vue";
import { useService } from "@harness/ui-di";
import codicons from "@iconify-json/codicon/icons.json";
import { ExtensionHostClientService } from "../client.ts";

const props = defineProps<{ sessionId?: string }>();
const client = useService(ExtensionHostClientService);
const errors = reactive(new Map<string, string>());
const items = computed(() => (props.sessionId ? [...client.chatStatusItems.values()] : []));
const icons = codicons.icons as Record<string, { body: string; width?: number; height?: number }>;

async function openLink(key: string, link: string) {
  errors.delete(key);
  try {
    await client.openChatStatusLink(link);
  } catch (error) {
    errors.set(key, error instanceof Error ? error.message : String(error));
  }
}

const StatusText = defineComponent({
  props: { text: { type: String, required: true }, itemKey: { type: String, required: true } },
  setup(value) {
    return () => {
      const parts = [];
      let offset = 0;
      for (const match of value.text.matchAll(
        /\$\(([a-z0-9-]+)(~spin)?\)|\[([^\]\n]+)\]\(([^)\s]+)\)/g,
      )) {
        parts.push(value.text.slice(offset, match.index));
        const icon = match[1] ? icons[match[1]] : undefined;
        if (icon) {
          parts.push(
            h("svg", {
              viewBox: `0 0 ${icon.width ?? 16} ${icon.height ?? 16}`,
              width: "1em",
              height: "1em",
              fill: "currentColor",
              "aria-hidden": "true",
              class: { "status-icon-spin": !!match[2] },
              innerHTML: icon.body,
            }),
          );
        } else if (match[3]) {
          parts.push(
            h(
              "button",
              {
                type: "button",
                class: "status-link",
                onClick: () => openLink(value.itemKey, match[4]!),
              },
              match[3],
            ),
          );
        } else parts.push(match[0]);
        offset = match.index + match[0].length;
      }
      parts.push(value.text.slice(offset));
      return h("span", { class: "status-text" }, parts);
    };
  },
});
</script>

<template>
  <div
    v-if="items.length"
    class="chat-status-items"
    role="status"
    aria-label="Chat extension status"
  >
    <div v-for="item in items" :key="item.key" class="chat-status-item">
      <strong v-if="typeof item.title === 'string'">{{ item.title }}</strong>
      <button
        v-else
        type="button"
        class="status-link"
        :title="item.title.helpText"
        @click="openLink(item.key, item.title.link)"
      >
        {{ item.title.label }}
      </button>
      <StatusText :text="item.description" :item-key="item.key" :title="item.tooltip" />
      <StatusText
        v-if="item.detail"
        class="status-detail"
        :text="item.detail"
        :item-key="item.key"
      />
      <span v-if="errors.has(item.key)" role="alert" class="status-error">{{
        errors.get(item.key)
      }}</span>
    </div>
  </div>
  <slot />
</template>

<style scoped>
.chat-status-items {
  display: grid;
  gap: 4px;
  padding: 8px;
  color: var(--fg);
  font-size: 12px;
  line-height: 18px;
}
.chat-status-item {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
}
.status-detail {
  color: var(--muted);
}
.status-error {
  color: var(--red);
}
:deep(.status-link) {
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}
:deep(.status-link:focus-visible) {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
:deep(.status-text svg) {
  display: inline-block;
  vertical-align: -0.125em;
}
:deep(.status-icon-spin) {
  animation: status-spin 1s linear infinite;
}
@keyframes status-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
