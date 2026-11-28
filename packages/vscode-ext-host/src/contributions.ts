import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { ExtensionContributionSnapshot } from "@harness/vscode-editor-compat/contributions";
import type { ExtensionManifest } from "./manifest.ts";

export async function readExtensionContributions(
  manifests: readonly ExtensionManifest[],
): Promise<ExtensionContributionSnapshot[]> {
  return Promise.all(
    manifests.map(async (manifest) => {
      const contributes = manifest.packageJSON?.contributes as Record<string, unknown> | undefined;
      const snapshot: ExtensionContributionSnapshot = {
        id: manifest.id,
        contributes: contributes ?? {},
        resources: {},
        errors: [],
      };
      let root: string;
      try {
        root = await fs.realpath(manifest.extensionPath);
      } catch (error) {
        snapshot.errors.push({ path: ".", message: String(error) });
        return snapshot;
      }
      try {
        const labels = JSON.parse(
          await fs.readFile(path.join(root, "package.nls.json"), "utf8"),
        ) as Record<string, string>;
        const localize = (value: unknown): unknown => {
          if (typeof value === "string" && value.startsWith("%") && value.endsWith("%"))
            return labels[value.slice(1, -1)] ?? value;
          if (Array.isArray(value)) return value.map(localize);
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value).map(([key, child]) => [key, localize(child)]),
            );
          return value;
        };
        snapshot.contributes = localize(snapshot.contributes) as Record<string, unknown>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          snapshot.errors.push({ path: "package.nls.json", message: String(error) });
      }
      const pending = new Set<string>();
      async function read(relativePath: string, kind: string): Promise<void> {
        const resolved = path.resolve(root, relativePath);
        const key = path.relative(root, resolved).split(path.sep).join("/");
        if (pending.has(key)) return;
        pending.add(key);
        try {
          const real = await fs.realpath(resolved);
          if (real !== root && !real.startsWith(root + path.sep))
            throw new Error("Contribution resource must remain within its extension directory");
          const bytes = await fs.readFile(real);
          const binary = /\.(woff2?|ttf|otf|eot|png|gif|jpe?g)$/i.test(real);
          const extension = path.extname(real).toLowerCase();
          const mimeType =
            extension === ".svg"
              ? "image/svg+xml"
              : extension === ".woff"
                ? "font/woff"
                : extension === ".woff2"
                  ? "font/woff2"
                  : extension === ".ttf"
                    ? "font/ttf"
                    : extension === ".png"
                      ? "image/png"
                      : "application/octet-stream";
          snapshot.resources[key] = {
            contents: bytes.toString(binary ? "base64" : "utf8"),
            encoding: binary ? "base64" : "utf8",
            mimeType,
          };
          if (kind !== "themes" && kind !== "iconThemes") return;
          const errors: ParseError[] = [];
          const data = parse(bytes.toString("utf8"), errors, {
            allowTrailingComma: true,
          }) as Record<string, any>;
          if (errors.length) throw new Error(`Invalid ${kind} JSONC (${errors[0]!.error})`);
          const relative = (asset: string) => path.join(path.dirname(key), asset);
          if (typeof data.include === "string") await read(relative(data.include), kind);
          if (kind === "themes" && typeof data.tokenColors === "string")
            await read(relative(data.tokenColors), "tokenColors");
          if (kind === "iconThemes") {
            for (const icon of Object.values(data.iconDefinitions ?? {}) as { iconPath?: string }[])
              if (icon.iconPath) await read(relative(icon.iconPath), "icon");
            for (const font of data.fonts ?? [])
              for (const source of font.src ?? [])
                if (source.path) await read(relative(source.path), "font");
          }
        } catch (error) {
          snapshot.errors.push({ path: key, message: String(error) });
        }
      }
      for (const kind of ["languages", "grammars", "snippets", "themes", "iconThemes"]) {
        for (const entry of (contributes?.[kind] ?? []) as {
          path?: string;
          configuration?: string;
        }[]) {
          const resource = kind === "languages" ? entry.configuration : entry.path;
          if (resource) await read(resource, kind);
        }
      }
      return snapshot;
    }),
  );
}
