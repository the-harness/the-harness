import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { inject } from "@harness/di";
import { SqliteService } from "@harness/sqlite";

interface SecretRow {
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export class SecretStorageService {
  private readonly sqlite = inject(SqliteService);
  private readonly profileId: string;
  private readonly rows = new Map<string, SecretRow>();
  private readonly encryptionKey: KeyObject | undefined;

  constructor(options: { readonly profileId: string; readonly key?: Uint8Array }) {
    if (options.key !== undefined && options.key.byteLength !== 32) {
      throw new Error("The extension secret storage key must contain 32 bytes.");
    }
    this.profileId = options.profileId;
    this.encryptionKey = options.key && createSecretKey(options.key);
    this.sqlite.createTable(
      "extension_secrets",
      `
      profile_id TEXT NOT NULL,
      extension_id TEXT NOT NULL,
      key TEXT NOT NULL,
      nonce BLOB NOT NULL,
      tag BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      PRIMARY KEY (profile_id, extension_id, key)
    `,
    );
    for (const row of this.sqlite.read<SecretRow & { extension_id: string; key: string }>(
      "SELECT extension_id, key, nonce, tag, ciphertext FROM extension_secrets WHERE profile_id = ?",
      this.profileId,
    )) {
      this.rows.set(`${row.extension_id}\0${row.key}`, row);
    }
  }

  get(extensionId: string, key: string): string | undefined {
    const encryptionKey = this.requireKey();
    const row = this.rows.get(`${extensionId}\0${JSON.stringify(key)}`);
    return row && this.decrypt(encryptionKey, extensionId, key, row);
  }

  store(
    extensionId: string,
    key: string,
    value: string,
    options?: { readonly keepExisting?: boolean },
  ): "changed" | "unchanged" | "conflict" {
    const existing = this.get(extensionId, key);
    if (existing === value) return "unchanged";
    if (existing !== undefined && options?.keepExisting) return "conflict";
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(), nonce);
    cipher.setAAD(this.identity(extensionId, key));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    this.sqlite.write(() => [
      [
        `INSERT INTO extension_secrets (profile_id, extension_id, key, nonce, tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, extension_id, key) DO UPDATE SET
         nonce = excluded.nonce, tag = excluded.tag, ciphertext = excluded.ciphertext`,
        this.profileId,
        extensionId,
        JSON.stringify(key),
        nonce,
        tag,
        ciphertext,
      ],
    ]);
    this.rows.set(`${extensionId}\0${JSON.stringify(key)}`, { nonce, tag, ciphertext });
    return "changed";
  }

  delete(extensionId: string, key: string): boolean {
    if (this.get(extensionId, key) === undefined) return false;
    this.sqlite.write(() => [
      [
        "DELETE FROM extension_secrets WHERE profile_id = ? AND extension_id = ? AND key = ?",
        this.profileId,
        extensionId,
        JSON.stringify(key),
      ],
    ]);
    this.rows.delete(`${extensionId}\0${JSON.stringify(key)}`);
    return true;
  }

  private requireKey(): KeyObject {
    if (!this.encryptionKey) throw new Error("Extension secret storage is not configured.");
    return this.encryptionKey;
  }

  private identity(extensionId: string, key: string): Buffer {
    return Buffer.from(JSON.stringify([this.profileId, extensionId, key]));
  }

  private decrypt(
    encryptionKey: KeyObject,
    extensionId: string,
    key: string,
    row: SecretRow,
  ): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, row.nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(this.identity(extensionId, key));
      decipher.setAuthTag(row.tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as string;
    } catch {
      throw new Error("Unable to decrypt the extension secret.");
    }
  }
}
