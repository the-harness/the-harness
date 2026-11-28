<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; component: SelectBox. Adaptation: Reka handles positioning, option selection, and keyboard navigation. -->
<script setup lang="ts">
import { computed } from "vue";
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui";

export type SelectOption = string | { readonly label: string; readonly value: string };

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  options: readonly SelectOption[];
  ariaLabel?: string;
}>();

const model = defineModel<string>({ required: true });

const normalizedOptions = computed(() =>
  props.options.map((option) =>
    typeof option === "string" ? { label: option, value: option } : option,
  ),
);
const selected = computed(() =>
  normalizedOptions.value.find((option) => option.value === model.value),
);

// Reka reserves the empty string. Existing callers can select it as a real value.
const pickerValue = computed({
  get: () => (selected.value ? `:${selected.value.value}` : null),
  set: (value: unknown) => {
    if (typeof value === "string") model.value = value.slice(1);
  },
});
</script>

<template>
  <SelectRoot v-model="pickerValue" :disabled="normalizedOptions.length === 0">
    <SelectTrigger
      v-bind="$attrs"
      class="select-box"
      :aria-label="ariaLabel"
      :title="selected?.label"
    >
      <SelectValue
        class="select-box-value"
        :placeholder="normalizedOptions.length ? 'Select an option' : 'No options available'"
      />
      <SelectIcon as-child><span class="i-codicon-chevron-down" aria-hidden="true" /></SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        class="select-box-popup"
        position="popper"
        align="start"
        :aria-label="ariaLabel"
        :disable-outside-pointer-events="false"
        :body-lock="false"
        :side-offset="2"
        :collision-padding="8"
      >
        <SelectViewport class="select-box-options">
          <SelectItem
            v-for="option in normalizedOptions"
            :key="option.value"
            class="select-box-option"
            :value="`:${option.value}`"
          >
            <span class="select-box-check" aria-hidden="true">
              <SelectItemIndicator as-child><span class="i-codicon-check" /></SelectItemIndicator>
            </span>
            <SelectItemText class="select-box-label">{{ option.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

<style scoped>
.select-box {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  max-width: min(100%, 360px);
  min-height: 26px;
  padding: 3px 7px;
  border: 1px solid var(--control-border);
  border-radius: 3px;
  background: var(--input);
  color: var(--fg);
  text-align: start;
}

.select-box[data-state="open"] {
  border-color: var(--selection-border);
}

.select-box:disabled {
  background: var(--surface);
  color: var(--muted);
  opacity: 1;
}

.select-box-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.select-box-popup) {
  z-index: 1600;
  width: max-content;
  min-width: min(var(--reka-select-trigger-width), var(--reka-select-content-available-width));
  max-width: min(420px, var(--reka-select-content-available-width));
  max-height: min(300px, var(--reka-select-content-available-height));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--control-border);
  border-radius: 4px;
  background: var(--raised);
  color: var(--fg);
  box-shadow: 0 4px 16px var(--shadow);
}

.select-box-options {
  min-height: 0;
  padding: 3px;
}

.select-box-option {
  display: flex;
  align-items: first baseline;
  gap: 6px;
  min-height: 24px;
  padding: 3px 6px;
  border-radius: 3px;
  outline: none;
  cursor: pointer;
}

.select-box-option[data-highlighted] {
  background: var(--menu-selection);
  color: var(--strong);
  outline: 1px solid var(--selection-border);
  outline-offset: -1px;
}

.select-box-check {
  flex: 0 0 14px;
}

.select-box-label {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
