export type { Workspace } from "@harness/workspace-catalog/types";

export interface WorkspaceFile {
  readonly path: string;
  readonly language: string;
  readonly status: string;
  readonly added: number;
  readonly removed: number;
  readonly content: string;
}

export const seedWorkspaceFiles: readonly WorkspaceFile[] = [
  {
    path: "src/workbench/registry.ts",
    language: "typescript",
    status: "M",
    added: 34,
    removed: 8,
    content: `import { shallowReactive, type Component } from 'vue';\n\nexport interface PanelDefinition {\n  id: string;\n  title: string;\n  icon: string;\n  component: Component;\n  location: 'left' | 'right' | 'below';\n}\n\nexport function createWorkbench() {\n  const panels = shallowReactive(new Map());\n\n  function register(panel: PanelDefinition) {\n    panels.set(panel.id, panel);\n    return () => panels.delete(panel.id);\n  }\n\n  return { panels, register };\n}\n`,
  },
  {
    path: "src/App.vue",
    language: "vue",
    status: "M",
    added: 18,
    removed: 4,
    content: `<script setup lang="ts">\nimport { provide } from 'vue';\nimport { DockviewVue } from 'dockview-vue';\nimport { createWorkbench, workbenchKey } from './workbench/registry';\n\nconst workbench = createWorkbench();\nprovide(workbenchKey, workbench);\n</script>\n\n<template>\n  <main class="workbench">\n    <DockviewVue @ready="onReady" />\n  </main>\n</template>\n`,
  },
  {
    path: "src/components/Composer.vue",
    language: "vue",
    status: "A",
    added: 62,
    removed: 0,
    content: `<script setup lang="ts">\nconst draft = defineModel<string>({ default: '' });\nconst emit = defineEmits<{ send: [text: string] }>();\n</script>\n\n<template>\n  <form @submit.prevent="emit('send', draft)">\n    <textarea v-model="draft" placeholder="Ask Harness anything…" />\n    <button type="submit">Send</button>\n  </form>\n</template>\n`,
  },
  {
    path: "package.json",
    language: "json",
    status: "",
    added: 0,
    removed: 0,
    content:
      '{\n  "name": "web",\n  "private": true,\n  "type": "module",\n  "scripts": { "dev": "vp dev" }\n}\n',
  },
  {
    path: "vite.config.ts",
    language: "typescript",
    status: "",
    added: 0,
    removed: 0,
    content: `import { defineConfig } from 'vite-plus';\nimport vue from '@vitejs/plugin-vue';\nimport UnoCSS from 'unocss/vite';\n\nexport default defineConfig({\n  plugins: [vue(), UnoCSS()],\n});\n`,
  },
];
