import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binaryName = process.platform === "win32" ? "rg.exe" : "rg";

export async function getRipgrepPath(): Promise<string> {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", binaryName);
  if (existsSync(bundled)) return bundled;
  return (await import("@vscode/ripgrep")).rgPath;
}

export async function copyFileSearchExecutable(directory: URL): Promise<void> {
  await copyFile(await getRipgrepPath(), new URL(binaryName, directory));
}
