<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Pane, List, CountBadge. Adaptation: source-control style change list and inline diff preview. -->
<script setup lang="ts">
import { Pane } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiWorkbenchService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";

const workbench = useService(UiWorkbenchService);
const workspace = useService(UiWorkspaceService);

const selectedFile = workspace.selectedFile;
const changedFiles = workspace.files.filter((f) => f.status);
</script>
<template>
  <section class="panel-fill changes-panel">
    <div class="overflow-auto flex-1">
      <Pane title="Example changes" :count="changedFiles.length" open>
        <p class="px-3 py-1 muted text-xs">Preview data · no files modified by the agent</p>
        <button
          v-for="file in changedFiles"
          :key="file.path"
          type="button"
          class="changed-file"
          :class="{ selected: selectedFile.path === file.path }"
          :title="file.path"
          @click="
            workspace.selectFile(file);
            workbench.open('preview');
          "
        >
          <span class="i-codicon-diff" aria-hidden="true" /><span class="min-w-0 flex-1"
            ><strong>{{ file.path.split("/").at(-1) }}</strong><small>{{ file.path }}</small></span
          ><span class="added">+{{ file.added }}</span
          ><span class="removed">−{{ file.removed }}</span>
        </button>
      </Pane>
      <div class="p-3">
        <div class="diff-example">
          <div class="diff-caption">registry.ts <span>example</span></div>
          <div class="diff-removed">− const views = [];</div>
          <div class="diff-added">+ const panels = shallowReactive(</div>
          <div class="diff-added">+ new Map(),</div>
          <div class="diff-added">+ );</div>
        </div>
      </div>
    </div>
  </section>
</template>
