import { isIP } from "node:net";
import { decodeCanonical } from "./encoding";
import { GatewayError, type GatewayClaims } from "./types";

const fields = [
  "v",
  "aud",
  "iat",
  "exp",
  "nonce",
  "sub",
  "name",
  "admin",
  "scopes",
  "method",
  "uri",
  "content_type",
  "body_sha256",
  "idempotency_key",
  "source_ip",
  "csrf_token",
  "csrf_verified",
];
const nonStrings = new Set([
  "v",
  "iat",
  "exp",
  "admin",
  "scopes",
  "csrf_verified",
]);
const allowedScopes = new Set(["doska:read", "doska:write", "doska:realtime"]);

export function validateClaims(
  claims: Record<string, unknown>,
  now: number,
): GatewayClaims {
  if (
    Object.keys(claims).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(claims, key))
  ) {
    throw new GatewayError("invalid_gateway_fields");
  }
  for (const field of fields) {
    if (nonStrings.has(field)) continue;
    const value = claims[field];
    if (
      typeof value !== "string" ||
      /\p{Cc}/u.test(value) ||
      /[\uD800-\uDFFF]/u.test(value)
    ) {
      throw new GatewayError("invalid_gateway_claim");
    }
  }
  if (
    claims.v !== 2 ||
    claims.aud !== "doska" ||
    typeof claims.admin !== "boolean" ||
    typeof claims.csrf_verified !== "boolean" ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp)
  ) {
    throw new GatewayError("invalid_gateway_claim");
  }
  const value = claims as unknown as GatewayClaims;
  if (
    !(
      value.exp > value.iat &&
      value.exp - value.iat <= 30 &&
      value.iat <= now + 5 &&
      value.exp >= now - 5
    )
  ) {
    throw new GatewayError("expired_gateway_assertion");
  }
  if (
    !Array.isArray(value.scopes) ||
    value.scopes.some(
      (scope, index) =>
        typeof scope !== "string" ||
        !allowedScopes.has(scope) ||
        (index > 0 && value.scopes[index - 1]! >= scope),
    )
  ) {
    throw new GatewayError("invalid_gateway_scopes");
  }
  for (const [field, limit, ascii] of [
    ["sub", 256, false],
    ["name", 512, false],
    ["uri", 4096, true],
    ["content_type", 256, true],
    ["idempotency_key", 128, true],
  ] as const) {
    if (
      Buffer.byteLength(value[field], "utf8") > limit ||
      (ascii && /[^\x20-\x7E]/u.test(value[field]))
    ) {
      throw new GatewayError("invalid_gateway_claim");
    }
  }
  const nonceSize = decodeCanonical(value.nonce).length;
  if (
    !value.sub ||
    !value.name ||
    nonceSize < 16 ||
    nonceSize > 64 ||
    !isIP(value.source_ip) ||
    value.source_ip.includes("%") ||
    decodeCanonical(value.csrf_token).length !== 32 ||
    !/^[a-f0-9]{64}$/.test(value.body_sha256)
  ) {
    throw new GatewayError("invalid_gateway_claim");
  }
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) });
}
