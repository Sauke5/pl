import { expect, it } from "vite-plus/test";
import { screenAttachmentStream } from "./screen-stream";
function source(bytes: Uint8Array, chunkSize: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset === bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset = Math.min(bytes.length, offset + chunkSize);
    },
  });
}
it.each([1, 7, 512, 2048])(
  "preserves bytes across chunk size %s",
  async (chunkSize) => {
    const bytes = Buffer.from("%PDF-1.7\n" + "x".repeat(3000));
    const result = await new Response(
      screenAttachmentStream(source(bytes, chunkSize), "pdf"),
    ).arrayBuffer();
    expect(Buffer.from(result)).toEqual(bytes);
  },
);
it("rejects wrong content before forwarding it", async () => {
  const reader = screenAttachmentStream(
    source(Buffer.from("MZ" + "x".repeat(2000)), 1),
    "pdf",
  ).getReader();
  await expect(reader.read()).rejects.toThrow("does not match");
});
it("checks short files at EOF", async () => {
  expect(
    await new Response(
      screenAttachmentStream(source(Buffer.from("notes"), 1), "txt"),
    ).text(),
  ).toBe("notes");
  await expect(
    new Response(
      screenAttachmentStream(source(Buffer.from("oops"), 1), "png"),
    ).arrayBuffer(),
  ).rejects.toThrow("does not match");
});
