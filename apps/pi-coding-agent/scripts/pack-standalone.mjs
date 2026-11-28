import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const app = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(app, "../..");
const artifacts = join(repository, "temp", "artifacts");
const nodeVersion = process.version;
const nodeOrigin = `https://nodejs.org/dist/${nodeVersion}`;
const platform = process.platform === "win32" ? "windows" : process.platform;
const { values } = parseArgs({
  options: { target: { type: "string" }, out: { type: "string" } },
});
const target = values.target ?? `${platform}-${process.arch}`;
const match = /^(darwin|linux|windows)-(arm64|x64)$/.exec(target);
if (!match)
  throw new Error(`Unsupported target ${target}. Use darwin, linux, or windows with arm64 or x64.`);
const [, targetPlatform, targetArch] = match;
const windows = targetPlatform === "windows";
const os = windows ? "win32" : targetPlatform;
const out = values.out
  ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out)
  : join(artifacts, "pi-standalone");
const tar = process.platform === "win32" ? "tar.exe" : "tar";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with status ${result.status ?? result.signal}`);
}

function deployDependencies(destination) {
  const pnpm = process.env.npm_execpath ?? "pnpm";
  const args = [
    "--filter",
    "@harness/pi-coding-agent-cli",
    "deploy",
    destination,
    "--prod",
    "--ignore-scripts",
    "--frozen-lockfile",
    "--node-linker",
    "hoisted",
    "--os",
    os,
    "--cpu",
    targetArch,
  ];
  if (os === "linux") args.push("--libc", "glibc");
  if (/\.[cm]?js$/i.test(pnpm)) run(process.execPath, [pnpm, ...args], repository);
  else run(pnpm, args, repository);
}

async function fetchReleaseFile(name) {
  const response = await fetch(`${nodeOrigin}/${name}`, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body)
    throw new Error(`Node release download failed for ${name}: HTTP ${response.status}`);
  return response;
}

async function installRuntime(stage, bundle) {
  const name = `node-${nodeVersion}-${windows ? "win" : targetPlatform}-${targetArch}`;
  const archive = `${name}.${windows ? "zip" : "tar.xz"}`;
  const checksums = await (await fetchReleaseFile("SHASUMS256.txt")).text();
  const expected = checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, filename]) => filename === archive)?.[0];
  if (!expected) throw new Error(`Missing checksum for ${archive}`);

  const path = join(stage, archive);
  const response = await fetchReleaseFile(archive);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${archive}`);
  if (windows && process.platform !== "win32") run("unzip", ["-q", path, "-d", stage]);
  else run(tar, ["-xf", path, "-C", stage]);
  await rename(join(stage, name), join(bundle, "runtime"));
}

const unixLauncher = `#!/bin/sh
self=$0
while [ -L "$self" ]; do
  destination=$(command -p readlink "$self") || exit 1
  case "$destination" in
    /*) self=$destination ;;
    *) self=$(command -p dirname "$self")/$destination ;;
  esac
done
root=$(CDPATH= cd "$(command -p dirname "$self")" && pwd -P) || exit 1
if [ -n "$PATH" ]; then
  PATH="$root/runtime/bin:$PATH"
else
  PATH="$root/runtime/bin"
fi
export PATH
exec "$root/runtime/bin/node" "$root/app/cli.js" "$@"
`;
const windowsLauncher = [
  "@echo off",
  "setlocal",
  'set "PATH=%~dp0runtime;%PATH%"',
  '"%~dp0runtime\\node.exe" "%~dp0app\\cli.js" %*',
  "exit /b %errorlevel%",
  "",
].join("\r\n");

await mkdir(artifacts, { recursive: true });
const stage = await mkdtemp(join(artifacts, "pi-standalone-"));
try {
  const bundle = join(stage, "harness-pi");
  const deployed = join(stage, "deploy");
  await mkdir(bundle);
  deployDependencies(deployed);
  await cp(join(app, "dist"), join(bundle, "app"), { recursive: true });
  const modules = join(deployed, "node_modules");
  for (const state of [".modules.yaml", ".pnpm-workspace-state-v1.json"]) {
    await rm(join(modules, state), { force: true });
  }
  await rename(modules, join(bundle, "app", "node_modules"));
  await installRuntime(stage, bundle);
  await writeFile(
    join(bundle, windows ? "harness-pi.cmd" : "harness-pi"),
    windows ? windowsLauncher : unixLauncher,
    {
      mode: 0o755,
    },
  );

  const archive = `harness-pi-${target}.${windows ? "zip" : "tar.gz"}`;
  await mkdir(out, { recursive: true });
  const publishing = await mkdtemp(join(out, ".pi-standalone-"));
  const path = join(publishing, archive);
  const destination = join(out, archive);
  try {
    if (!windows) {
      const crossPackLinux = process.platform === "darwin" && targetPlatform === "linux";
      const archiveTar = crossPackLinux ? "/usr/bin/tar" : tar;
      const metadataOptions = crossPackLinux ? ["--no-mac-metadata", "--no-xattrs"] : [];
      run(archiveTar, ["-czf", path, ...metadataOptions, "-C", stage, "harness-pi"]);
    } else if (process.platform === "win32") run(tar, ["-a", "-cf", path, "-C", bundle, "."]);
    else run("zip", ["-q", "-r", path, "."], bundle);
    await rename(path, destination);
    console.log(destination);
  } finally {
    await rm(publishing, { recursive: true, force: true });
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
