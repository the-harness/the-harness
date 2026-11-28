import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

function manifestVsix(manifest: object): Buffer {
  const name = Buffer.from("extension/package.json");
  const contents = Buffer.from(JSON.stringify(manifest));
  const checksum = crc32(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + contents.length, 16);
  return Buffer.concat([local, name, contents, central, name, end]);
}

it("scans and VSIX installs publish the contribution revision with or without running sessions", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "content-refresh-host-"));
  const extensions = join(root, "extensions");
  mkdirSync(join(extensions, "fixture"), { recursive: true });
  const manifest = {
    publisher: "audit",
    name: "content-refresh",
    version: "1.0.0",
    contributes: { languages: [{ id: "content-refresh", extensions: [".refresh"] }] },
  };
  writeFileSync(join(extensions, "fixture/package.json"), JSON.stringify(manifest));
  const fixture = await createExtensionHostFixture();
  const revision = fixture.service.contributionsVersion;
  const initial = revision.value;
  const published: string[] = [];
  const off = revision.subscribe(() => published.push(revision.value));
  try {
    await fixture.service.scanExtensions(extensions);
    expect(published).toEqual([revision.value]);
    const scanned = revision.value;
    expect(scanned).not.toBe(initial);
    await fixture.service.startSession("first", [], { storageRoot: join(root, "storage") });
    await fixture.service.startSession("second", [], { storageRoot: join(root, "storage") });
    const vsixPath = join(root, "fixture.vsix");
    writeFileSync(vsixPath, manifestVsix({ ...manifest, version: "2.0.0" }));
    const installed = await fixture.service.installVsix(vsixPath, join(root, "installed"));
    expect(installed.version).toBe("2.0.0");
    expect(revision.value).not.toBe(scanned);
    expect(published).toEqual([scanned, revision.value]);
    expect((await fixture.service.getContributions()).map((snapshot) => snapshot.id)).toContain(
      "audit.content-refresh",
    );
    off();
    await expect(fixture.service.scanExtensions(join(root, "missing"))).resolves.toEqual([]);
    expect((await fixture.service.getContributions()).map((snapshot) => snapshot.id)).toContain(
      "audit.content-refresh",
    );
  } finally {
    off();
    await fixture.dispose("first", "second");
  }
});

it("deactivates a removed runtime extension in each worker and keeps other extensions active", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "runtime-extension-removal-"));
  const extensions = join(root, "extensions");
  for (const name of ["removed", "retained"]) {
    const directory = join(extensions, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        publisher: "audit",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: [`onCommand:fixture.${name}`],
      }),
    );
    writeFileSync(
      join(directory, "extension.cjs"),
      `
const fs = require("node:fs");
const vscode = require("vscode");
let log;
let runs = 0;
exports.activate = ({ subscriptions }) => {
  subscriptions.push(vscode.commands.registerCommand("fixture.${name}", path => {
    log = path;
    return ++runs;
  }));
  subscriptions.push({ dispose: () => { if (log) fs.appendFileSync(log, "disposed\\n"); } });
};
exports.deactivate = () => { if (log) fs.appendFileSync(log, "deactivated\\n"); };
`,
    );
  }
  const dependent = join(extensions, "dependent");
  mkdirSync(dependent);
  writeFileSync(
    join(dependent, "package.json"),
    JSON.stringify({
      name: "dependent",
      publisher: "audit",
      version: "1.0.0",
      extensionDependencies: ["audit.removed"],
    }),
  );
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const registrations = new Set<string>();
  const off = host.onMainThreadCall(async (session, method, args, id) => {
    if (method === "commands.register") registrations.add(`${session}:${args[0]}`);
    if (method === "commands.unregister") registrations.delete(`${session}:${args[0]}`);
    host.resolveMainCall(id, method === "memento.load" ? {} : undefined);
  });
  const sessions = ["remove-first", "remove-second"];
  try {
    await host.scanExtensions(extensions);
    for (const session of sessions) {
      await host.startSession(session, [root], { storageRoot: join(root, "storage") });
      expect(await host.executeCommand(session, "fixture.removed", join(root, session))).toBe(1);
      expect(await host.executeCommand(session, "fixture.retained")).toBe(1);
    }
    await expect(host.removeExtension("audit.removed")).resolves.toBe(false);
    await expect(host.removeContentExtension("audit.dependent")).resolves.toBe(true);
    await expect(host.removeExtension("audit.removed")).resolves.toBe(true);
    for (const session of sessions) {
      expect(readFileSync(join(root, session), "utf8")).toBe("deactivated\ndisposed\n");
      expect(registrations.has(`${session}:fixture.removed`)).toBe(false);
      await expect(host.executeCommand(session, "fixture.removed")).rejects.toThrow(
        "Command not found",
      );
      expect(await host.executeCommand(session, "fixture.retained")).toBe(2);
    }
    await expect(host.removeExtension("audit.removed")).resolves.toBe(false);
  } finally {
    await fixture.dispose(...sessions);
    off();
    rmSync(root, { recursive: true, force: true });
  }
});
