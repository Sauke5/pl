import { expect, it } from "vite-plus/test";
import { attachmentContentMatches } from "./content";
it.each([
  ["pdf", "%PDF-1.7"],
  ["rtf", "{\\rtf1"],
  ["txt", "Русский текст\n"],
  ["csv", "name,value\r\n1,2"],
  ["gif", "GIF89a"],
  ["webp", "RIFF1234WEBP"],
])("accepts matching %s signature", (extension, header) => {
  expect(attachmentContentMatches(extension, Buffer.from(header))).toBe(true);
});
it.each(["pdf", "jpg", "docx", "txt", "zip"])(
  "rejects executable renamed %s",
  (extension) => {
    for (const header of ["4d5a9000", "7f454c460201", "feedfacf", "cafebabe"]) {
      expect(
        attachmentContentMatches(extension, Buffer.from(header, "hex")),
      ).toBe(false);
    }
  },
);
it("checks container and image signatures rather than the declared MIME", () => {
  expect(
    attachmentContentMatches("png", Buffer.from("89504e470d0a1a0a", "hex")),
  ).toBe(true);
  expect(attachmentContentMatches("png", Buffer.from("%PDF-1.7"))).toBe(false);
  expect(attachmentContentMatches("docx", Buffer.from("504b0304", "hex"))).toBe(
    true,
  );
  expect(attachmentContentMatches("docx", Buffer.from("not a document"))).toBe(
    false,
  );
  expect(attachmentContentMatches("txt", Buffer.from([1, 2, 0, 3]))).toBe(
    false,
  );
  expect(
    attachmentContentMatches("txt", Buffer.from([0xff, 0xfe, 0x41, 0])),
  ).toBe(true);
});
it("rejects unknown and truncated formats", () => {
  expect(attachmentContentMatches("exe", Buffer.from("anything"))).toBe(false);
  expect(attachmentContentMatches("pdf", Buffer.from("%PD"))).toBe(false);
  expect(attachmentContentMatches("png", new Uint8Array())).toBe(false);
});
