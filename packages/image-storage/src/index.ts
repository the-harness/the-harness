import { createHash } from "node:crypto";
import { inject } from "@harness/di";
import { RpcServerService } from "@harness/rpc";
import { SqliteService } from "@harness/sqlite";
import { ImageRpcContract, type UploadedImageMeta } from "./contract.ts";

export { ImageRpcContract, UploadedImageMeta } from "./contract.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const IMAGE_ID_PATTERN = /^([a-f0-9]{64})\.(png|jpg|jpeg|gif|webp)$/;

export class ImageStorageService {
  private readonly sqlite = inject(SqliteService);

  constructor() {
    this.sqlite.createTable(
      "attachments",
      `
      id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      filename TEXT,
      bytes INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    `,
    );
  }

  save(buffer: Buffer, mimeType: string, filename?: string): UploadedImageMeta {
    const normalizedMime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!Object.hasOwn(MIME_TO_EXT, normalizedMime)) {
      throw new Error(`Unsupported image type: ${mimeType || "unknown"}`);
    }
    if (buffer.byteLength === 0) {
      throw new Error("Image file is empty");
    }
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB limit`);
    }

    const hash = createHash("sha256").update(buffer).digest("hex");
    const id = `${hash}.${MIME_TO_EXT[normalizedMime]}`;

    this.sqlite.write(() => [
      [
        `INSERT OR IGNORE INTO attachments (id, mime_type, filename, bytes, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        normalizedMime,
        filename ?? null,
        buffer.byteLength,
        buffer,
        Date.now(),
      ],
    ]);

    return {
      id,
      mimeType: normalizedMime,
      ...(filename ? { filename } : {}),
      bytes: buffer.byteLength,
    };
  }

  async read(id: string): Promise<{ readonly data: Buffer; readonly mimeType: string } | null> {
    if (!IMAGE_ID_PATTERN.test(id)) return null;
    const lookup = () =>
      this.sqlite.read<{ mime_type: string; data: Uint8Array }>(
        "SELECT mime_type, data FROM attachments WHERE id = ?",
        id,
      )[0];
    let row = lookup();
    if (!row) {
      // 已提交的内容哈希不会变。只有未命中时，才需要等刚受理的上传。
      await this.sqlite.flush();
      row = lookup();
    }
    if (!row) return null;
    return {
      data: Buffer.from(row.data),
      mimeType: row.mime_type,
    };
  }

  async readBase64(
    id: string,
  ): Promise<{ readonly data: string; readonly mimeType: string } | null> {
    const result = await this.read(id);
    if (!result) return null;
    return {
      data: result.data.toString("base64"),
      mimeType: result.mimeType,
    };
  }
}

export function useImageHandlers(): void {
  const images = inject(ImageStorageService);
  inject(RpcServerService).useHandlers(ImageRpcContract, {
    upload: ({ data, mimeType, filename }) =>
      images.save(Buffer.from(data, "base64"), mimeType, filename),
    read: ({ id }) => images.readBase64(id),
  });
}
