import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { it, expect } from "vite-plus/test";

it(
  "installs an executable for Harness alongside the upstream Pi dependency",
  { timeout: 120_000 },
  () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-package-"));
    const build = join(temp, "dist");
    const install = join(temp, "install");
    mkdirSync(install);
    try {
      execFileSync("pnpm", [
        "--filter",
        "@harness/pi-coding-agent-cli",
        "build",
        "--outDir",
        build,
      ]);
      const pack = execFileSync("npm", ["pack", build, "--json", "--pack-destination", temp], {
        encoding: "utf8",
      });
      const [{ filename }] = JSON.parse(pack) as [{ filename: string }];
      execFileSync(
        "npm",
        ["install", "--ignore-scripts", "--prefer-offline", "--no-audit", join(temp, filename)],
        { cwd: install },
      );
      const help = execFileSync("npm", ["exec", "--offline", "--", "harness-pi", "--help"], {
        cwd: install,
        encoding: "utf8",
      });
      expect(help).toContain("Continue the most recent session in this directory");

      const extension = join(temp, "probe.ts");
      writeFileSync(
        extension,
        `
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "probe",
    label: "Probe",
    description: "Probe",
    parameters: Type.Object({}),
    async execute() { return { content: [], details: {} }; },
  });
  pi.registerCommand("probe", { description: "Probe", handler() {} });
  pi.on("session_shutdown", () => { console.log("extension shutdown"); });
}
`,
      );
      const output = execFileSync(
        "npm",
        [
          "exec",
          "--offline",
          "--",
          "harness-pi",
          "-p",
          "--no-session",
          "-ne",
          "-e",
          extension,
          "/probe",
        ],
        {
          cwd: install,
          encoding: "utf8",
          env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent") },
        },
      );
      expect(output.trim()).toBe("extension shutdown");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "darwin")(
  "omits AppleDouble files and xattrs when cross-packing Linux",
  () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-linux-package-"));
    try {
      const app = join(temp, "apps", "pi-coding-agent");
      const packer = join(app, "scripts", "pack-standalone.mjs");
      mkdirSync(join(app, "scripts"), { recursive: true });
      mkdirSync(join(app, "dist"));
      copyFileSync(new URL("../scripts/pack-standalone.mjs", import.meta.url), packer);
      writeFileSync(join(app, "dist", "cli.js"), "");

      const runtime = `node-${process.version}-linux-x64`;
      const release = join(temp, `${runtime}.tar.xz`);
      mkdirSync(join(temp, runtime, "bin"), { recursive: true });
      writeFileSync(join(temp, runtime, "bin", "node"), "", { mode: 0o755 });
      execFileSync("/usr/bin/tar", [
        "-cJf",
        release,
        "--no-mac-metadata",
        "--no-xattrs",
        "-C",
        temp,
        runtime,
      ]);
      const hash = createHash("sha256").update(readFileSync(release)).digest("hex");

      const fakeFetch = join(temp, "fetch.mjs");
      writeFileSync(
        fakeFetch,
        `
      import { readFile } from "node:fs/promises";
      globalThis.fetch = async (url) => {
        if (new URL(url).pathname.endsWith("/SHASUMS256.txt")) {
          return new Response(${JSON.stringify(`${hash}  ${runtime}.tar.xz\n`)});
        }
        return new Response(await readFile(${JSON.stringify(release)}));
      };
    `,
      );
      const fakeDeploy = join(temp, "deploy.mjs");
      writeFileSync(
        fakeDeploy,
        `
      import { execFileSync } from "node:child_process";
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const modules = join(process.argv[process.argv.indexOf("deploy") + 1], "node_modules");
      mkdirSync(modules, { recursive: true });
      const file = join(modules, "fixture.js");
      writeFileSync(file, "");
      execFileSync("/usr/bin/xattr", ["-w", "user.harness-fixture", "present", file]);
    `,
      );
      const output = join(temp, "out");
      execFileSync(
        process.execPath,
        ["--import", fakeFetch, packer, "--target", "linux-x64", "--out", output],
        {
          env: { ...process.env, npm_execpath: fakeDeploy },
        },
      );
      const archive = join(output, "harness-pi-linux-x64.tar.gz");
      const names = execFileSync("/usr/bin/tar", ["-tzf", archive, "--no-mac-metadata"], {
        encoding: "utf8",
      });
      expect(names).toContain("harness-pi/app/node_modules/fixture.js");
      expect(names).toContain("harness-pi/harness-pi");
      expect(names).not.toContain("/._");
      expect(gunzipSync(readFileSync(archive)).includes("xattr.user.harness-fixture")).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
