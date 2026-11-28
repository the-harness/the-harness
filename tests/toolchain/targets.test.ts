import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import webConfig from "../../apps/web/vite.config.ts";

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

interface Tsconfig {
  compilerOptions?: { target?: string; lib?: string[] };
}

interface Manifest {
  engines?: { node?: string };
}

describe("toolchain targets", () => {
  it("keeps the app and package on the declared ES2024 and Node 26 baseline", () => {
    const root = JSON.parse(read("tsconfig.json")) as Tsconfig;
    const web = JSON.parse(read("apps/web/tsconfig.json")) as Tsconfig;
    const manifest = JSON.parse(read("package.json")) as Manifest;

    expect(root.compilerOptions?.target).toBe("ES2024");
    expect(web.compilerOptions?.lib).toContain("ES2024");
    expect(web.compilerOptions?.lib).toContain("DOM");
    expect(webConfig.build?.target).toBe("es2024");
    expect(manifest.engines?.node).toBe("26.x");
  });
});
