import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["references/**"],
  },
  lint: {
    ignorePatterns: ["references/**"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "harness", specifier: "./packages/lint-plugin/src/index.ts" },
    ],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    overrides: [
      {
        // Modules apps/web hot updates through DiHmrPlugin.
        files: ["packages/*/src/**/*.ts", "apps/web/src/server/**/*.ts"],
        rules: { "harness/no-module-state": "error" },
      },
      {
        // The hot runtime and registries that reload or re-run their importers instead, and entries
        // that run outside the Vite module graph: the production server and the extension host.
        files: [
          "apps/web/src/server/prod.ts",
          "packages/di/src/**",
          "packages/hot/src/**",
          "packages/variants/src/**",
          "packages/vscode-ext-host/src/worker.ts",
          "packages/vscode-ext-host/src/vscode/**",
        ],
        rules: { "harness/no-module-state": "off" },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["tests/**/*.test.ts", "apps/**/*.test.ts"],
    passWithNoTests: true,
  },
  run: {
    cache: true,
  },
});
