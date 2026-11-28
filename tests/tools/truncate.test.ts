import { describe, expect, it } from "vite-plus/test";
import { formatSize, truncateHead, truncateTail } from "../../packages/pi-tools/src/truncate.ts";

function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe("formatSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(1023)).toBe("1023B");
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(1536)).toBe("1.5KB");
    expect(formatSize(1024 * 1024)).toBe("1.0MB");
    expect(formatSize(1024 * 1024 * 1.5)).toBe("1.5MB");
  });
});

describe("truncateHead", () => {
  it("leaves short content untouched and ignores a trailing newline when counting lines", () => {
    expect(truncateHead("a\nb\n", { maxLines: 2, maxBytes: 10 })).toMatchObject({
      content: "a\nb\n",
      truncated: false,
      truncatedBy: null,
      totalLines: 2,
      outputLines: 2,
    });
    expect(truncateHead("", { maxLines: 2 })).toMatchObject({
      content: "",
      truncated: false,
      totalLines: 0,
      outputLines: 0,
    });
  });

  it("keeps the first whole lines and reports the line limit", () => {
    const result = truncateHead("one\ntwo\nthree\nfour", { maxLines: 2, maxBytes: 100 });
    expect(result).toMatchObject({
      content: "one\ntwo",
      truncated: true,
      truncatedBy: "lines",
      totalLines: 4,
      outputLines: 2,
    });
  });

  it("keeps the first whole lines that fit the byte budget", () => {
    const result = truncateHead("12345\n67890", { maxLines: 10, maxBytes: 7 });
    expect(result).toMatchObject({
      content: "12345",
      truncated: true,
      truncatedBy: "bytes",
      totalLines: 2,
      totalBytes: 11,
      outputLines: 1,
      outputBytes: 5,
    });
  });

  it("flags a first line that alone exceeds the byte budget", () => {
    const result = truncateHead("abcdefgh", { maxLines: 10, maxBytes: 3 });
    expect(result).toMatchObject({
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      firstLineExceedsLimit: true,
      outputLines: 0,
      outputBytes: 0,
    });
  });

  it("never splits a multi-byte character at the byte boundary", () => {
    const result = truncateHead("😀\n😀", { maxLines: 10, maxBytes: 5 });
    expect(result.content).toBe("😀");
    expect(result.truncatedBy).toBe("bytes");
    expect(hasLoneSurrogate(result.content)).toBe(false);
  });
});

describe("truncateTail", () => {
  it("keeps the last whole lines and reports the line limit", () => {
    const result = truncateTail("one\ntwo\nthree\nfour", { maxLines: 2, maxBytes: 100 });
    expect(result).toMatchObject({
      content: "three\nfour",
      truncated: true,
      truncatedBy: "lines",
      totalLines: 4,
      outputLines: 2,
    });
  });

  it("keeps the last complete lines that fit the byte budget", () => {
    const result = truncateTail("12345\n67890\nabc", { maxLines: 10, maxBytes: 10 });
    expect(result).toMatchObject({
      content: "67890\nabc",
      truncated: true,
      truncatedBy: "bytes",
      totalLines: 3,
      outputLines: 2,
      lastLinePartial: false,
    });
  });

  it("returns a partial last line only when the line itself exceeds the budget", () => {
    const result = truncateTail("prefix-123456789", { maxLines: 10, maxBytes: 5 });
    expect(result).toMatchObject({
      content: "56789",
      truncated: true,
      truncatedBy: "bytes",
      lastLinePartial: true,
      outputLines: 1,
      outputBytes: 5,
    });
  });

  it("starts a partial tail on a character boundary instead of a continuation byte", () => {
    const emoji = "😀";
    const result = truncateTail(emoji.repeat(3), { maxLines: 10, maxBytes: 6 });
    expect(result).toMatchObject({
      content: emoji,
      truncated: true,
      truncatedBy: "bytes",
      lastLinePartial: true,
      outputBytes: 4,
    });
    expect(hasLoneSurrogate(result.content)).toBe(false);
  });
});
