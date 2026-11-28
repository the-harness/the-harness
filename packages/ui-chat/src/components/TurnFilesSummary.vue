<script setup lang="ts">
import { computed, ref } from "vue";
import { useService } from "@harness/ui-di";
import type { TurnFileChange } from "@harness/ui-chat";
import { UiWorkbenchService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";

const props = defineProps<{
  changes: readonly TurnFileChange[];
}>();

const workbench = useService(UiWorkbenchService);
const workspace = useService(UiWorkspaceService);
const expanded = ref(false);
const PREVIEW_LIMIT = 3;

const totals = computed(() => {
  let added = 0;
  let removed = 0;
  for (const item of props.changes) {
    added += item.added;
    removed += item.removed;
  }
  return { added, removed };
});

const visibleRows = computed(() => {
  const slice = expanded.value ? props.changes : props.changes.slice(0, PREVIEW_LIMIT);
  return slice.map((change) => {
    const idx = change.path.lastIndexOf("/");
    return {
      change,
      base: idx >= 0 ? change.path.slice(idx + 1) : change.path,
      dir: idx > 0 ? change.path.slice(0, idx) : "",
    };
  });
});

const hiddenCount = computed(() => Math.max(0, props.changes.length - PREVIEW_LIMIT));

function openChange(path: string) {
  const found = workspace.files.find((item) => item.path === path || item.path.endsWith(path));
  if (found) workspace.selectFile(found);
  workbench.open("changes");
}
</script>

<template>
  <div class="turn-files">
    <div class="tf-card">
      <div class="tf-card-head" @click="workbench.open('changes')">
        <span class="i-codicon-diff tf-ic" aria-hidden="true" />
        <strong class="tf-title"
          >{{ changes.length }} {{ changes.length === 1 ? "file" : "files" }} changed</strong
        >
        <span class="tf-stats">
          <span v-if="totals.added > 0" class="added">+{{ totals.added }}</span>
          <span v-if="totals.removed > 0" class="removed">−{{ totals.removed }}</span>
          <span class="diffbar" aria-hidden="true">
            <span class="seg-add" :style="{ flexGrow: totals.added || 1 }" />
            <span v-if="totals.removed > 0" class="seg-del" :style="{ flexGrow: totals.removed }" />
          </span>
        </span>
      </div>
      <ul class="tf-list">
        <li v-for="row in visibleRows" :key="row.change.path" class="tf-row">
          <button
            type="button"
            class="tf-file"
            :title="row.change.path"
            @click="openChange(row.change.path)"
          >
            <span class="tf-base">{{ row.base }}</span>
            <span v-if="row.dir" class="tf-dir">{{ row.dir }}</span>
          </button>
          <span class="tf-row-stats">
            <span v-if="row.change.added > 0" class="added">+{{ row.change.added }}</span>
            <span v-if="row.change.removed > 0" class="removed">−{{ row.change.removed }}</span>
          </span>
        </li>
      </ul>
      <button
        v-if="hiddenCount > 0"
        type="button"
        class="tf-more"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span>{{ expanded ? "Show less" : `${hiddenCount} more file(s)` }}</span>
        <span
          class="i-codicon-chevron-down tf-more-car"
          :class="{ open: expanded }"
          aria-hidden="true"
        />
      </button>
    </div>
  </div>
</template>
