import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ExtensionManifest {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly extensionPath: string;
  readonly main?: string;
  readonly activationEvents: readonly string[];
  readonly packageJSON?: Record<string, unknown>;
  readonly extensionDependencies?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string; readonly title: string }[];
  };
}

export async function readExtensionManifest(
  extensionDir: string,
): Promise<ExtensionManifest | null> {
  const pkgPath = path.join(extensionDir, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof pkg.name === "string" ? pkg.name : path.basename(extensionDir);
    const publisher = typeof pkg.publisher === "string" ? pkg.publisher : "local";
    const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    const main = typeof pkg.main === "string" ? path.resolve(extensionDir, pkg.main) : undefined;
    const activationEvents = Array.isArray(pkg.activationEvents)
      ? pkg.activationEvents.filter((e): e is string => typeof e === "string")
      : [];
    const contributes =
      typeof pkg.contributes === "object" && pkg.contributes !== null
        ? (pkg.contributes as ExtensionManifest["contributes"])
        : undefined;

    return {
      id: `${publisher}.${name}`,
      name,
      publisher,
      version,
      extensionPath: extensionDir,
      main,
      activationEvents,
      contributes,
      packageJSON: pkg,
      extensionDependencies: Array.isArray(pkg.extensionDependencies)
        ? pkg.extensionDependencies.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export async function scanExtensionsDir(extensionsDir: string): Promise<ExtensionManifest[]> {
  try {
    const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
    const manifests: ExtensionManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await readExtensionManifest(path.join(extensionsDir, entry.name));
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  } catch {
    return [];
  }
}
