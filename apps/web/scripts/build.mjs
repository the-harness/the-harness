import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { copyFileSearchExecutable } from "@harness/vscode-ext-host/ripgrep";
import { build } from "vite-plus";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
await build({ root: appRoot, build: { outDir: "dist/client" } });
await copyFileSearchExecutable(new URL("../dist/", import.meta.url));
await build({
  root: appRoot,
  ssr: { noExternal: true, external: ["node-pty", "@vscode/ripgrep"] },
  build: {
    ssr: true,
    target: "node26",
    outDir: "dist/server",
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("../src/server/prod.ts", import.meta.url)),
        "extension-host": fileURLToPath(
          new URL("../../../packages/vscode-ext-host/src/worker.ts", import.meta.url),
        ),
      },
      output: {
        entryFileNames: "[name].mjs",
        chunkFileNames: "[name]-[hash].mjs",
      },
    },
  },
});
