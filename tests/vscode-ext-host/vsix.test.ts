import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  readExtensionManifest,
  scanExtensionsDir,
} from "../../packages/vscode-ext-host/src/manifest.ts";
import { installVsix } from "../../packages/vscode-ext-host/src/vsix.ts";

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-vsix-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const manifest = {
  name: "demo",
  publisher: "acme",
  version: "1.2.3",
  main: "./main.js",
  activationEvents: ["onStartup", 42],
  contributes: { commands: [{ command: "demo.hello", title: "Hello" }] },
};

describe("extension manifests", () => {
  it("applies defaults and resolves the main module", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "ext"));
    writeFileSync(
      join(root, "ext/package.json"),
      JSON.stringify({ version: "0.1.0", main: "src/main.js", activationEvents: "nope" }),
    );
    const loaded = await readExtensionManifest(join(root, "ext"));
    expect(loaded).toMatchObject({
      id: "local.ext",
      name: "ext",
      publisher: "local",
      version: "0.1.0",
      extensionPath: join(root, "ext"),
      main: join(root, "ext/src/main.js"),
      activationEvents: [],
    });

    expect(await readExtensionManifest(join(root, "missing"))).toBeNull();
  });

  it("scans only directories with readable manifests", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "one"), { recursive: true });
    mkdirSync(join(root, "two"), { recursive: true });
    writeFileSync(join(root, "one/package.json"), JSON.stringify({ name: "one", publisher: "p" }));
    writeFileSync(join(root, "two/package.json"), "{bad");
    writeFileSync(join(root, "file.txt"), "ignored");
    const found = await scanExtensionsDir(root);
    expect(found.map((item) => item.id)).toEqual(["p.one"]);
    expect(await scanExtensionsDir(join(root, "missing"))).toEqual([]);
  });
});

describe("vsix installation", () => {
  it("unpacks extension files and reinstalls into an id-version directory", async () => {
    const root = tempRoot();
    const vsixPath = join(root, "demo.vsix");
    const extensionsDir = join(root, "extensions");
    writeFileSync(
      vsixPath,
      zip({
        "extension/package.json": JSON.stringify(manifest),
        "extension/main.js": "export const value = 1;\n",
        "../escaped.txt": "must not escape",
      }),
    );

    const installed = await installVsix(vsixPath, extensionsDir);
    expect(installed).toMatchObject({
      id: "acme.demo",
      version: "1.2.3",
      main: join(extensionsDir, "acme.demo-1.2.3/main.js"),
      activationEvents: ["onStartup"],
    });
    expect(readFileSync(join(extensionsDir, "acme.demo-1.2.3/main.js"), "utf-8")).toBe(
      "export const value = 1;\n",
    );
    expect(() => readFileSync(join(root, "escaped.txt"), "utf-8")).toThrow();

    const scanned = await scanExtensionsDir(extensionsDir);
    expect(scanned.map((item) => item.id)).toEqual(["acme.demo"]);
  });

  it("rejects archives without an end record or extension manifest", async () => {
    const root = tempRoot();
    const extensionsDir = join(root, "extensions");
    const invalid = join(root, "invalid.vsix");
    writeFileSync(invalid, "not a zip");
    await expect(installVsix(invalid, extensionsDir)).rejects.toThrow(
      "Invalid .vsix archive: missing EOCD",
    );

    const missing = join(root, "missing.vsix");
    writeFileSync(missing, zip({ "extension/readme.md": "hi" }));
    await expect(installVsix(missing, extensionsDir)).rejects.toThrow(
      "missing extension/package.json",
    );
  });
});
