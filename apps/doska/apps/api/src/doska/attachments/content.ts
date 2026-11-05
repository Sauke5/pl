/** Format screening only: archives are not unpacked and this is not malware scanning. */
export function attachmentContentMatches(
  extension: string,
  prefix: Uint8Array,
): boolean {
  const b = Buffer.from(prefix);
  const hex = (value: string, offset = 0) =>
    b
      .subarray(offset, offset + value.length / 2)
      .equals(Buffer.from(value, "hex"));
  const ascii = (value: string, offset = 0) =>
    b
      .subarray(offset, offset + value.length)
      .equals(Buffer.from(value, "ascii"));
  // Reject direct executable containers even if their filename claims a document type.
  if (
    ascii("MZ") ||
    hex("7f454c46") ||
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].some((v) =>
      hex(v),
    )
  )
    return false;
  if (
    ["txt", "csv", "log", "md", "json", "xml", "yaml", "yml"].includes(
      extension,
    )
  ) {
    if (hex("fffe") || hex("feff")) return true;
    return b.length > 0 && !b.some((v) => v < 32 && ![9, 10, 13].includes(v));
  }
  if (["doc", "xls", "ppt"].includes(extension)) return hex("d0cf11e0a1b11ae1");
  if (["docx", "xlsx", "pptx", "odt", "ods", "odp", "zip"].includes(extension))
    return hex("504b0304") || hex("504b0506");
  if (["jpg", "jpeg"].includes(extension)) return hex("ffd8ff");
  if (["tif", "tiff"].includes(extension))
    return hex("49492a00") || hex("4d4d002a");
  if (["heic", "heif", "avif"].includes(extension)) {
    return (
      ascii("ftyp", 4) &&
      ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis"].some(
        (brand) => ascii(brand, 8),
      )
    );
  }
  switch (extension) {
    case "pdf":
      return ascii("%PDF-");
    case "rtf":
      return ascii("{\\rtf");
    case "png":
      return hex("89504e470d0a1a0a");
    case "gif":
      return ascii("GIF87a") || ascii("GIF89a");
    case "webp":
      return ascii("RIFF") && ascii("WEBP", 8);
    case "bmp":
      return ascii("BM");
    case "7z":
      return hex("377abcaf271c");
    case "rar":
      return hex("526172211a0700") || hex("526172211a070100");
    case "gz":
      return hex("1f8b08");
    case "bz2":
      return ascii("BZh");
    case "xz":
      return hex("fd377a585a00");
    case "tar":
      return ascii("ustar", 257);
    default:
      return false;
  }
}
