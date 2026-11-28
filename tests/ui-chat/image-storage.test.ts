import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");
type ImagesModule = typeof import("../../packages/image-storage/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let sqlite: SqliteModule;
let images: ImagesModule;
let tempDir: string;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, sqlite, images] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
    harness.load<ImagesModule>("/packages/image-storage/src/index.ts"),
  ]);
  tempDir = mkdtempSync(join(tmpdir(), "harness-image-storage-"));
});

afterAll(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await harness.close();
});

async function openStorage(path: string) {
  const scope = di.createRootScope();
  scope.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path }),
    images.ImageStorageService,
  ]);
  const sqliteService = scope.get(sqlite.SqliteService);
  const storage = scope.get(images.ImageStorageService);
  return {
    scope,
    storage,
    sqlite: sqliteService,
    async close() {
      try {
        await sqliteService.close();
      } finally {
        scope.dispose();
      }
    },
  };
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x03]);

describe("image storage", () => {
  it("stores uploaded bytes and reads them back after reopening the database", async () => {
    const path = join(tempDir, "persist.db");
    const first = await openStorage(path);
    const meta = first.storage.save(png, "image/png; charset=binary", "shot.png");
    expect(meta).toMatchObject({
      mimeType: "image/png",
      filename: "shot.png",
      bytes: png.byteLength,
    });
    expect(meta.id).toMatch(/^[a-f0-9]{64}\.png$/);
    await first.close();

    const second = await openStorage(path);
    try {
      const stored = await second.storage.read(meta.id);
      expect(stored?.mimeType).toBe("image/png");
      expect(stored?.data.equals(png)).toBe(true);
      const base64 = await second.storage.readBase64(meta.id);
      expect(base64).toEqual({ data: png.toString("base64"), mimeType: "image/png" });
    } finally {
      await second.close();
    }
  });

  it("deduplicates identical uploads and keeps distinct images separate", async () => {
    const opened = await openStorage(join(tempDir, "dedupe.db"));
    try {
      const a = opened.storage.save(png, "image/png");
      const b = opened.storage.save(png, "image/png", "second-name.png");
      const c = opened.storage.save(gif, "image/gif");
      expect(a.id).toBe(b.id);
      expect(c.id).not.toBe(a.id);
      expect(c.id).toMatch(/^[a-f0-9]{64}\.gif$/);

      await opened.sqlite.flush();
      const rows = opened.sqlite.read<{
        id: string;
        mime_type: string;
        filename: string | null;
        bytes: number;
      }>("SELECT id, mime_type, filename, bytes FROM attachments ORDER BY mime_type");
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === a.id)).toMatchObject({
        mime_type: "image/png",
        filename: null,
        bytes: png.byteLength,
      });
      expect((await opened.storage.read(a.id))?.data.equals(png)).toBe(true);
      expect((await opened.storage.read(c.id))?.data.equals(gif)).toBe(true);
    } finally {
      await opened.close();
    }
  });

  it("reads a committed upload when the following batch fails to prepare", async () => {
    const opened = await openStorage(join(tempDir, "upload-before-failure.db"));
    try {
      const { id } = opened.storage.save(png, "image/png");
      const nextBatch = Promise.resolve().then(() => {
        expect(() =>
          opened.sqlite.write(() => {
            throw new Error("invalid snapshot");
          }),
        ).toThrow("invalid snapshot");
      });
      const image = opened.storage.read(id);
      await nextBatch;
      await expect(image).resolves.toEqual({ data: png, mimeType: "image/png" });
      await expect(opened.sqlite.flush()).rejects.toThrow("invalid snapshot");
      await expect(opened.storage.read(id)).resolves.toEqual({ data: png, mimeType: "image/png" });
    } finally {
      await expect(opened.close()).rejects.toThrow("invalid snapshot");
    }
  });

  it("rejects unsupported or empty payloads without writing a row", async () => {
    const opened = await openStorage(join(tempDir, "reject.db"));
    try {
      expect(() => opened.storage.save(Buffer.alloc(0), "image/png")).toThrow(
        "Image file is empty",
      );
      for (const mime of ["text/plain", "", "constructor", "__proto__"]) {
        expect(() => opened.storage.save(png, mime)).toThrow("Unsupported image type");
      }
      await opened.sqlite.flush();
      const [row] = opened.sqlite.read<{ count: number }>(
        "SELECT COUNT(*) AS count FROM attachments",
      );
      expect(row!.count).toBe(0);
    } finally {
      await opened.close();
    }
  });

  it("returns null for malformed ids and unknown images", async () => {
    const opened = await openStorage(join(tempDir, "lookup.db"));
    try {
      const meta = opened.storage.save(png, "image/png");
      expect(await opened.storage.read("../etc/passwd")).toBeNull();
      expect(await opened.storage.read("not-an-image")).toBeNull();
      expect(await opened.storage.read(`${"a".repeat(64)}.png`)).toBeNull();
      expect(await opened.storage.read(meta.id.replace(/\.png$/, ".jpg"))).toBeNull();
      expect(await opened.storage.readBase64(`${"b".repeat(64)}.webp`)).toBeNull();
    } finally {
      await opened.close();
    }
  });
});
