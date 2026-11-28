import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { readExtensionManifest, type ExtensionManifest } from "./manifest.ts";

function extractZipBuffer(buf: Buffer, destRoot: string): Array<{ relPath: string; data: Buffer }> {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Invalid .vsix archive: missing EOCD");

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const files: Array<{ relPath: string; data: Buffer }> = [];

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) {
      throw new Error("Invalid .vsix archive: bad central directory header");
    }
    const method = buf.readUInt16LE(cdOffset + 10);
    const compressedSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const relPath = buf.toString("utf-8", cdOffset + 46, cdOffset + 46 + nameLen);
    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (relPath.endsWith("/")) continue;
    const resolved = path.resolve(destRoot, relPath);
    if (!resolved.startsWith(path.resolve(destRoot) + path.sep)) continue;

    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported .vsix compression method: ${method}`);
    }
    files.push({ relPath, data });
  }
  return files;
}

export async function installVsix(
  vsixPath: string,
  extensionsDir: string,
): Promise<ExtensionManifest> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-vsix-"));
  try {
    const buf = await fs.readFile(vsixPath);
    const entries = extractZipBuffer(buf, stagingDir);
    for (const entry of entries) {
      const target = path.join(stagingDir, entry.relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.data);
    }

    const extRoot = path.join(stagingDir, "extension");
    const manifest = await readExtensionManifest(extRoot);
    if (!manifest) {
      throw new Error(`Invalid .vsix archive: missing extension/package.json in ${vsixPath}`);
    }

    await fs.mkdir(extensionsDir, { recursive: true });
    const destDir = path.join(extensionsDir, `${manifest.id}-${manifest.version}`);
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.cp(extRoot, destDir, { recursive: true });

    const installed = await readExtensionManifest(destDir);
    if (!installed) {
      throw new Error(`Failed to verify installed extension at ${destDir}`);
    }
    return installed;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}
