import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { validateClaims } from "./claims";
import { decodeCanonical, parseClaimsJson } from "./encoding";
import {
  GatewayError,
  type DoskaScope,
  type GatewayClaims,
  type GatewayRequest,
  type NonceStore,
} from "./types";

declare const uploadHeadersVerified: unique symbol;
/** Authenticated upload headers only; the received stream is not yet verified. */
export type UploadHeaderClaims = GatewayClaims & {
  readonly [uploadHeadersVerified]: true;
};
const maxUploadBodyBytes = 25 * 1024 * 1024;

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const methods = new Set([...safeMethods, "POST", "PUT", "PATCH", "DELETE"]);
const protectedHeaders = new Set([
  "x-pl-gateway-assertion",
  "x-pl-gateway-signature",
  "content-type",
  "idempotency-key",
  "x-csrf-token",
  "content-encoding",
]);
const forbiddenHeaders = new Set([
  "authorization",
  "cookie",
  "x-user",
  "remote-user",
  "x-remote-user",
  "x-authenticated-user",
]);

function readHeaders(pairs: GatewayRequest["headers"]) {
  const headers = new Map<string, string>();
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase();
    if (
      forbiddenHeaders.has(name) ||
      (name.startsWith("x-pl-") && !protectedHeaders.has(name))
    ) {
      throw new GatewayError("unexpected_gateway_header");
    }
    if (!protectedHeaders.has(name)) continue;
    if (headers.has(name)) throw new GatewayError("duplicate_gateway_header");
    headers.set(name, value);
  }
  return headers;
}

export class DoskaGatewayVerifier {
  private readonly key: Buffer;

  constructor(
    key: Uint8Array,
    private readonly nonces: NonceStore,
  ) {
    if (key.length !== 32)
      throw new Error("Gateway key must contain exactly 32 raw bytes");
    this.key = Buffer.from(key);
  }

  async verify(
    request: GatewayRequest,
    options: {
      requiredScope: DoskaScope;
      now?: number;
      /** Handler-specific bound; callers must also enforce bounded body reads. */
      maxBodyBytes?: number;
    },
  ): Promise<GatewayClaims> {
    return this.verifyRequest(request, options, request.body);
  }

  /**
   * Caller must restrict this to the exact upload route and bound stream reads.
   * Reserves the nonce before reading bytes; success does not authenticate a body.
   */
  async verifyUploadHeaders(
    request: Omit<GatewayRequest, "body">,
    options: { requiredScope: DoskaScope; now?: number },
  ): Promise<UploadHeaderClaims> {
    return (await this.verifyRequest(request, options)) as UploadHeaderClaims;
  }

  /**
   * Internal receiver only: size/hash MUST be computed from the actual stream,
   * never from client declarations. Expiry was checked at header admission;
   * the bounded stream may finish after the assertion's short TTL.
   */
  verifyUploadBody(
    claims: UploadHeaderClaims,
    actual: { size: number; sha256: string },
    options: { maxBodyBytes?: number } = {},
  ): GatewayClaims {
    const maxBodyBytes = options.maxBodyBytes ?? maxUploadBodyBytes;
    if (
      !Number.isSafeInteger(maxBodyBytes) ||
      maxBodyBytes < 0 ||
      maxBodyBytes > maxUploadBodyBytes
    )
      throw new GatewayError("invalid_gateway_configuration", 503);
    if (!Number.isSafeInteger(actual.size) || actual.size < 0)
      throw new GatewayError("gateway_request_mismatch");
    if (actual.size > maxBodyBytes)
      throw new GatewayError("request_body_too_large", 413);
    if (
      !/^[a-f0-9]{64}$/.test(actual.sha256) ||
      actual.sha256 !== claims.body_sha256
    )
      throw new GatewayError("gateway_request_mismatch");
    return claims;
  }

  private async verifyRequest(
    request: Omit<GatewayRequest, "body">,
    options: { requiredScope: DoskaScope; now?: number; maxBodyBytes?: number },
    body?: Uint8Array,
  ): Promise<GatewayClaims> {
    const now = options.now ?? Date.now() / 1000;
    const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
    if (
      !Number.isFinite(now) ||
      !Number.isSafeInteger(maxBodyBytes) ||
      maxBodyBytes < 0
    ) {
      throw new GatewayError("invalid_gateway_configuration", 503);
    }
    const headers = readHeaders(request.headers);
    const assertion = headers.get("x-pl-gateway-assertion") ?? "";
    if (
      !assertion ||
      assertion.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/.test(assertion)
    ) {
      throw new GatewayError("invalid_gateway_assertion");
    }
    const signature = decodeCanonical(
      headers.get("x-pl-gateway-signature") ?? "",
    );
    const expected = createHmac("sha256", this.key)
      .update(`pl-gateway-v2\n${assertion}`, "ascii")
      .digest();
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    ) {
      throw new GatewayError("invalid_gateway_signature");
    }
    const claims = validateClaims(
      parseClaimsJson(decodeCanonical(assertion)),
      now,
    );
    const safe = safeMethods.has(request.method);
    if (
      !claims.scopes.includes(options.requiredScope) ||
      (!safe && !claims.scopes.includes("doska:write"))
    ) {
      throw new GatewayError("gateway_scope_denied", 403);
    }
    if (body && body.byteLength > maxBodyBytes)
      throw new GatewayError("request_body_too_large", 413);
    const path = request.rawUri.split("?", 1)[0] ?? "";
    if (
      !methods.has(request.method) ||
      !path.startsWith("/api/") ||
      /[^\x21-\x7E]/u.test(request.rawUri) ||
      request.rawUri.includes("#") ||
      /[%\\]/u.test(path) ||
      path.includes("//") ||
      path.split("/").some((segment) => segment === "." || segment === "..") ||
      claims.method !== request.method ||
      claims.uri !== `/doska${request.rawUri}` ||
      claims.content_type !== (headers.get("content-type") ?? "") ||
      claims.idempotency_key !== (headers.get("idempotency-key") ?? "") ||
      (body !== undefined
        ? claims.body_sha256 !== createHash("sha256").update(body).digest("hex")
        : request.method !== "PUT" ||
          claims.content_type !== "application/octet-stream") ||
      !["", "identity"].includes(headers.get("content-encoding") ?? "")
    ) {
      throw new GatewayError("gateway_request_mismatch");
    }
    if (safe) {
      if (body?.byteLength || claims.csrf_verified)
        throw new GatewayError("invalid_gateway_csrf", 403);
    } else {
      const csrf = Buffer.from(headers.get("x-csrf-token") ?? "", "utf8");
      const signedCsrf = Buffer.from(claims.csrf_token, "ascii");
      if (
        !claims.csrf_verified ||
        csrf.length !== signedCsrf.length ||
        !timingSafeEqual(csrf, signedCsrf)
      ) {
        throw new GatewayError("invalid_gateway_csrf", 403);
      }
      let result: Awaited<ReturnType<NonceStore["reserve"]>>;
      try {
        result = await this.nonces.reserve({
          audience: "doska",
          nonce: claims.nonce,
          expiresAt: claims.exp + 5,
          now,
        });
      } catch {
        throw new GatewayError("gateway_nonce_store_unavailable", 503);
      }
      if (result === "replay") throw new GatewayError("gateway_replay", 409);
      if (result !== "reserved")
        throw new GatewayError("gateway_nonce_store_unavailable", 503);
    }
    return claims;
  }
}
