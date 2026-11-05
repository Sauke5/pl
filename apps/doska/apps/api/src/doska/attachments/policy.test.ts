import { describe, expect, it } from "vite-plus/test";
import { MAX_ATTACHMENT_BYTES, validateAttachmentMetadata } from "./policy";

describe("attachment metadata", () => {
  it.each([
    "Инструкция.pdf",
    "Расчёт.XLSX",
    "Фото.png",
    "Архив.tar.gz",
    "notes.md",
  ])("accepts %s", (filename) => {
    expect(
      validateAttachmentMetadata({ filename, size: MAX_ATTACHMENT_BYTES })
        .filename,
    ).toBe(filename);
  });
  it("normalizes display name without changing its extension", () => {
    expect(
      validateAttachmentMetadata({ filename: "  Cafe\u0301.txt  ", size: 1 })
        .filename,
    ).toBe("Café.txt");
  });
  it.each([
    "run.exe",
    "a.pdf.exe",
    "script.ps1",
    "script.js",
    "page.html",
    "image.svg",
    "macro.docm",
    "README",
  ])("rejects %s", (filename) => {
    expect(() => validateAttachmentMetadata({ filename, size: 1 })).toThrow(
      "unsupported_file_type",
    );
  });
  it.each([
    "../a.txt",
    "a\\b.txt",
    ".hidden.txt",
    "a\u0000.txt",
    "a\n.txt",
    "a\u202etxt.exe",
    "я".repeat(128) + ".txt",
  ])("rejects unsafe filename %j", (filename) => {
    expect(() => validateAttachmentMetadata({ filename, size: 1 })).toThrow(
      "invalid_filename",
    );
  });
  it.each([0, -1, 1.5, Number.NaN, Infinity])(
    "rejects invalid size %s",
    (size) => {
      expect(() =>
        validateAttachmentMetadata({ filename: "a.txt", size }),
      ).toThrow("invalid_file_size");
    },
  );
  it("rejects a file one byte over the limit", () => {
    expect(() =>
      validateAttachmentMetadata({
        filename: "a.txt",
        size: MAX_ATTACHMENT_BYTES + 1,
      }),
    ).toThrow("file_too_large");
  });
});
