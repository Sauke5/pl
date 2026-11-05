import { attachmentContentMatches } from "./content";

export class AttachmentContentError extends Error {
  constructor() {
    super("Attachment content does not match its file type");
    this.name = "AttachmentContentError";
  }
}

/** Hold only the first 512 bytes for format screening, then forward with backpressure. */
export function screenAttachmentStream(
  source: ReadableStream<Uint8Array>,
  extension: string,
) {
  const prefix = new Uint8Array(512);
  let length = 0;
  let checked = false;
  const check = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!attachmentContentMatches(extension, prefix.subarray(0, length)))
      throw new AttachmentContentError();
    checked = true;
    controller.enqueue(prefix.subarray(0, length));
  };
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (checked) {
          controller.enqueue(chunk);
          return;
        }
        const take = Math.min(prefix.length - length, chunk.length);
        prefix.set(chunk.subarray(0, take), length);
        length += take;
        if (length === prefix.length) {
          check(controller);
          if (take < chunk.length) controller.enqueue(chunk.subarray(take));
        }
      },
      flush(controller) {
        if (!checked) check(controller);
      },
    }),
  );
}
