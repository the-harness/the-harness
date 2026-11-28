<script setup lang="ts">
import { useService } from "@harness/ui-di";
import { VueEditService } from "./packages/vue-edit/service.ts";

const service = useService(VueEditService);
</script>

<template>
  <span data-testid="hmr-client-vue-probe">{{ service.label }}</span>
</template>
