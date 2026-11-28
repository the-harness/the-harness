function charWidth(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte < 0xc2) return 0;
  if (byte < 0xe0) return 2;
  if (byte < 0xf0) return 3;
  if (byte < 0xf5) return 4;
  return 0;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function isContinuationIn(byte: number, low: number, high: number): boolean {
  return byte >= low && byte <= high;
}

function validPrefix(first: number, second: number, width: number): boolean {
  if (width === 3) {
    return (
      isContinuationIn(second, 0x80, 0xbf) &&
      !(first === 0xe0 && second < 0xa0) &&
      !(first === 0xed && second > 0x9f)
    );
  }
  return (
    isContinuationIn(second, 0x80, 0xbf) &&
    !(first === 0xf0 && second < 0x90) &&
    !(first === 0xf4 && second > 0x8f)
  );
}

function invalidSequence(index: number, length: number): string {
  return `invalid utf-8 sequence of ${length} bytes from index ${index}`;
}

function incompleteSequence(index: number): string {
  return `incomplete utf-8 byte sequence from index ${index}`;
}

function scanInvalid(bytes: Uint8Array): string {
  let index = 0;
  while (index < bytes.length) {
    const start = index;
    const first = bytes.at(index);
    if (first === undefined) break;
    const width = charWidth(first);
    if (width === 1) {
      index += 1;
      continue;
    }
    if (width === 2) {
      const second = bytes.at(index + 1);
      if (second === undefined) return incompleteSequence(start);
      if (!isContinuation(second)) return invalidSequence(start, 1);
      index += 2;
      continue;
    }
    if (width < 3) return invalidSequence(start, 1);
    const second = bytes.at(index + 1);
    if (second === undefined) return incompleteSequence(start);
    if (!validPrefix(first, second, width)) return invalidSequence(start, 1);
    for (let offset = 2; offset < width; offset += 1) {
      const byte = bytes.at(index + offset);
      if (byte === undefined) return incompleteSequence(start);
      if (!isContinuation(byte)) return invalidSequence(start, offset);
    }
    index += width;
  }
  return invalidSequence(index, 1);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function utf8DecodeError(bytes: Uint8Array): string | undefined {
  try {
    decode(bytes);
    return undefined;
  } catch {
    return scanInvalid(bytes);
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decode(bytes);
}
