import iconv from "iconv-lite";
import type { createConfigurationApi } from "./configuration.ts";
import type { Uri } from "./types.ts";

interface EncodingOptions {
  readonly uri?: Uri;
  readonly encoding?: string;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const guessable = new Map(
  [
    "UTF-8",
    "UTF-16LE",
    "UTF-16BE",
    "windows-1252",
    "windows-1250",
    "ISO-8859-2",
    "windows-1251",
    "IBM866",
    "IBM1125",
    "ISO-8859-5",
    "KOI8-R",
    "windows-1253",
    "ISO-8859-7",
    "windows-1255",
    "ISO-8859-8",
    "Big5",
    "SHIFT_JIS",
    "EUC-JP",
    "EUC-KR",
    "GB2312",
  ].map((name) => [normalize(name), name]),
);
guessable.set("cp866", "IBM866");
guessable.set("cp1125", "IBM1125");
guessable.set("cp950", "Big5");
guessable.set("gbk", "GB2312");

const detectorAliases: Readonly<Record<string, string>> = { ibm866: "cp866", big5: "cp950" };
const ignoredGuesses = new Set(["ascii", "utf16", "utf32"]);

function supportedEncoding(name: unknown): string {
  const encoding = typeof name === "string" ? normalize(name) : "";
  return encoding === "utf8bom" || (encoding && iconv.encodingExists(encoding)) ? encoding : "utf8";
}

function detectUnicode(bytes: Buffer): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";

  // Only the leading sample is used to distinguish binary data from BOM-less UTF-16.
  const size = Math.min(bytes.length, 512);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < size; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) evenZeros++;
    else oddZeros++;
  }
  if (evenZeros || oddZeros) {
    if (!evenZeros && oddZeros === Math.floor(size / 2)) return "utf16le";
    if (!oddZeros && evenZeros === Math.ceil(size / 2)) return "utf16be";
    throw new Error("Cannot decode binary content as text");
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf8";
}

async function guessEncoding(
  bytes: Buffer,
  candidates: readonly string[],
): Promise<string | undefined> {
  const { default: jschardet } = await import("jschardet");
  const sample = bytes.subarray(0, 64 * 1024);
  const names = [
    ...new Set(
      candidates
        .map((name) => guessable.get(normalize(name)))
        .filter((name): name is string => name !== undefined),
    ),
  ];
  let detected: string | undefined;
  try {
    const result = jschardet.detect(
      sample.toString("latin1"),
      names.length ? { detectEncodings: names } : undefined,
    );
    if (result?.encoding) detected = normalize(result.encoding);
  } catch {
    return undefined;
  }
  if (detected) {
    const encoding = detectorAliases[detected] ?? detected;
    return ignoredGuesses.has(detected) || !iconv.encodingExists(encoding) ? undefined : encoding;
  }

  if (!names.length) return undefined;
  try {
    // The sample may stop partway through a valid multi-byte character.
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return undefined;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  const roundTrips = names
    .map((name) => {
      const key = normalize(name);
      return detectorAliases[key] ?? key;
    })
    .filter(
      (encoding) =>
        !encoding.startsWith("utf") &&
        iconv.encodingExists(encoding) &&
        iconv.encode(iconv.decode(sample, encoding), encoding).equals(sample),
    );
  return roundTrips.length === 1 ? roundTrips[0] : undefined;
}

export function createWorkspaceEncoding(
  getConfiguration: ReturnType<typeof createConfigurationApi>["getConfiguration"],
  workspaceRoots: () => readonly Uri[],
) {
  function hasWorkspaceEncodingOverride(uri?: Uri): boolean {
    if (!uri) return false;
    if (uri.path.endsWith(".code-workspace")) return true;
    return workspaceRoots().some((root) => {
      if (root.scheme !== uri.scheme || root.authority !== uri.authority) return false;
      const settingsPath = root.path.replace(/\/$/, "") + "/.vscode";
      return uri.path.startsWith(settingsPath + "/");
    });
  }

  return {
    async encode(content: string, options?: EncodingOptions): Promise<Uint8Array> {
      const configured = getConfiguration("files", options?.uri).get("encoding");
      const selected = hasWorkspaceEncodingOverride(options?.uri)
        ? "utf8"
        : supportedEncoding(options?.encoding || configured);
      const addBOM = selected === "utf8bom" || selected === "utf16le" || selected === "utf16be";
      return new Uint8Array(
        iconv.encode(content, selected === "utf8bom" ? "utf8" : selected, { addBOM }),
      );
    },
    async decode(content: Uint8Array, options?: EncodingOptions): Promise<string> {
      const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      const detected = detectUnicode(bytes);
      if (hasWorkspaceEncodingOverride(options?.uri)) return iconv.decode(bytes, "utf8");
      const config = getConfiguration("files", options?.uri);
      let guessed: string | undefined;
      if (!options?.encoding && !detected && config.get("autoGuessEncoding", false)) {
        const candidates = config.get<unknown>("candidateGuessEncodings");
        const allowed = Array.isArray(candidates)
          ? candidates.filter((value): value is string => typeof value === "string")
          : [];
        guessed = await guessEncoding(bytes, allowed);
      }
      const selected = supportedEncoding(
        options?.encoding || detected || guessed || config.get("encoding"),
      );
      return iconv.decode(bytes, selected === "utf8bom" ? "utf8" : selected);
    },
  };
}
