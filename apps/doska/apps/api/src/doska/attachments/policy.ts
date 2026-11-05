export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const extensions = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "txt",
  "csv",
  "log",
  "md",
  "json",
  "xml",
  "yaml",
  "yml",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
  "zip",
  "7z",
  "rar",
  "tar",
  "gz",
  "bz2",
  "xz",
]);

export type AttachmentPolicyErrorCode =
  | "invalid_filename"
  | "unsupported_file_type"
  | "invalid_file_size"
  | "file_too_large";
export class AttachmentPolicyError extends Error {
  constructor(public readonly code: AttachmentPolicyErrorCode) {
    super(code);
    this.name = "AttachmentPolicyError";
  }
}

/** Metadata validation; uploaded bytes must be verified separately before publication. */
export function validateAttachmentMetadata(input: {
  filename: string;
  size: number;
}) {
  const filename = input.filename.normalize("NFC").trim();
  if (
    !filename ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    /[\p{Cc}/\\\u202a-\u202e\u2066-\u2069]/u.test(filename) ||
    filename.startsWith(".") ||
    filename.endsWith(".")
  ) {
    throw new AttachmentPolicyError("invalid_filename");
  }
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (!filename.includes(".") || !extensions.has(extension)) {
    throw new AttachmentPolicyError("unsupported_file_type");
  }
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new AttachmentPolicyError("invalid_file_size");
  }
  if (input.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentPolicyError("file_too_large");
  }
  return { filename, size: input.size, extension };
}
