import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";
import { dependencies, description, engines, license, name, version } from "./package.json";

export default defineConfig({
  build: {
    ssr: "src/cli.ts",
    target: "node26",
    rolldownOptions: {
      external: Object.keys(dependencies),
      output: { entryFileNames: "cli.js", banner: "#!/usr/bin/env node" },
    },
  },
  plugins: [
    {
      name: "pi-cli-distribution",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "package.json",
          source: JSON.stringify(
            {
              name,
              version,
              description,
              license,
              engines,
              type: "module",
              bin: { "harness-pi": "./cli.js" },
              dependencies,
            },
            null,
            2,
          ),
        });
        this.emitFile({
          type: "asset",
          fileName: "LICENSE",
          source: readFileSync(new URL("../../LICENSE", import.meta.url)),
        });
        this.emitFile({
          type: "asset",
          fileName: "LICENSE.pi",
          source: readFileSync(new URL("./LICENSE.pi", import.meta.url)),
        });
      },
    },
  ],
  ssr: { noExternal: true },
});
