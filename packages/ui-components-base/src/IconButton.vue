<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: IconButton, ActionBar. Adaptation: native labeled action with UnoCSS Codicons. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
defineProps<{ icon: string; label: string; active?: boolean }>();
</script>
<template>
  <button class="icon-button" :class="{ active }" :aria-label="label" :title="label" type="button">
    <span :class="icon" aria-hidden="true" />
  </button>
</template>
