import { GatewayError } from "./types";

export function decodeCanonical(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GatewayError("invalid_gateway_encoding");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new GatewayError("invalid_gateway_encoding");
  }
  return bytes;
}

/** Called only after authenticating the encoded bytes. JSON.parse alone loses duplicate keys. */
export function parseClaimsJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GatewayError("invalid_gateway_json");
    }
    // JSON.parse validates grammar first. This token pass preserves escaped key
    // spellings and numeric lexical types that JS otherwise silently normalizes.
    const tokens =
      text.match(
        /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/gu,
      ) ?? [];
    const objects: Set<string>[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token === "{") objects.push(new Set());
      else if (token === "}") objects.pop();
      else if (token.startsWith('"') && tokens[index + 1] === ":") {
        const key = JSON.parse(token) as string;
        const keys = objects.at(-1)!;
        if (keys.has(key)) throw new GatewayError("duplicate_gateway_claim");
        keys.add(key);
        if (
          objects.length === 1 &&
          ["v", "iat", "exp"].includes(key) &&
          !/^-?(?:0|[1-9]\d*)$/.test(tokens[index + 2] ?? "")
        ) {
          throw new GatewayError("invalid_gateway_claim");
        }
      }
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("invalid_gateway_json");
  }
}
