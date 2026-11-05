import { readFileSync } from "node:fs";
import type { HttpBindings } from "@hono/node-server";
import type { User } from "better-auth/types";
import { and, eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import db from "../database";
import {
  platformDirectoryStateTable,
  platformUserIdentityTable,
  userTable,
} from "../database/schema";
import { PostgresNonceStore } from "./gateway/postgres-nonce-store";
import {
  GatewayError,
  type DoskaScope,
  type GatewayClaims,
} from "./gateway/types";
import { DoskaGatewayVerifier } from "./gateway/verifier";

export type DoskaHttpEnv = {
  Bindings: Partial<HttpBindings>;
  Variables: {
    userId: string;
    userEmail: string;
    user: User;
    session: null;
    apiKey: null;
    doskaIdentity: {
      subject: string;
      validUntil: Date;
      csrfToken: string;
      verified: true;
    };
  };
};

export type ResolvedDoskaIdentity = {
  subject: string;
  active: boolean;
  observedAt: Date;
  validUntil: Date;
  user: User;
};

/** The subject is the only identity lookup key. Claims name/admin never grant access. */
export async function resolveDoskaIdentity(
  subject: string,
  database: Pick<typeof db, "select"> = db,
): Promise<ResolvedDoskaIdentity | null> {
  const [row] = await database
    .select({
      subject: platformUserIdentityTable.subject,
      active: platformUserIdentityTable.active,
      observedAt: platformUserIdentityTable.observedAt,
      validUntil:
        sql<Date>`LEAST(${platformUserIdentityTable.validUntil}, ${platformDirectoryStateTable.validUntil})`.mapWith(
          platformUserIdentityTable.validUntil,
        ),
      user: userTable,
    })
    .from(platformUserIdentityTable)
    .innerJoin(userTable, eq(userTable.id, platformUserIdentityTable.userId))
    .innerJoin(
      platformDirectoryStateTable,
      eq(platformDirectoryStateTable.id, "directory"),
    )
    .where(
      and(
        eq(platformUserIdentityTable.subject, subject),
        eq(platformUserIdentityTable.active, true),
        sql`${platformUserIdentityTable.observedAt} <= (statement_timestamp() AT TIME ZONE 'utc')`,
        sql`${platformUserIdentityTable.validUntil} > (statement_timestamp() AT TIME ZONE 'utc')`,
        sql`${platformDirectoryStateTable.observedAt} <= (statement_timestamp() AT TIME ZONE 'utc')`,
        sql`${platformDirectoryStateTable.validUntil} > (statement_timestamp() AT TIME ZONE 'utc')`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Load only a dedicated raw32 file; never interpret an environment value as key material. */
export function loadDoskaGatewayVerifier(
  keyFile = process.env.DOSKA_GATEWAY_KEY_FILE,
) {
  try {
    if (!keyFile) throw new Error();
    return new DoskaGatewayVerifier(
      readFileSync(keyFile),
      new PostgresNonceStore(),
    );
  } catch {
    throw new GatewayError("gateway_configuration_unavailable", 503);
  }
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new GatewayError("invalid_gateway_configuration", 503);
  if (request.bodyUsed)
    throw new GatewayError("gateway_raw_request_unavailable", 503);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new GatewayError("request_body_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createDoskaHttpIdentity(options: {
  requiredScope: DoskaScope;
  maxBodyBytes?: number;
  verifier?: Pick<DoskaGatewayVerifier, "verify">;
  resolveIdentity?: (subject: string) => Promise<ResolvedDoskaIdentity | null>;
  now?: () => number;
}) {
  // Lazily resolve configuration so disabled integrated mode requires no key.
  let verifier = options.verifier;
  return createMiddleware<DoskaHttpEnv>(async (c, next) => {
    try {
      const incoming = c.env?.incoming;
      if (
        !incoming?.url ||
        !incoming.method ||
        !Array.isArray(incoming.rawHeaders) ||
        incoming.rawHeaders.length % 2
      )
        throw new GatewayError("gateway_raw_request_unavailable", 503);
      const headers: [string, string][] = [];
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const name = incoming.rawHeaders[i];
        const value = incoming.rawHeaders[i + 1];
        if (typeof name !== "string" || typeof value !== "string")
          throw new GatewayError("gateway_raw_request_unavailable", 503);
        headers.push([name, value]);
      }
      // Fetch cannot represent GET/HEAD bodies, so reject their raw HTTP framing.
      if (
        ["GET", "HEAD"].includes(incoming.method) &&
        headers.some(
          ([name, value]) =>
            name.toLowerCase() === "transfer-encoding" ||
            (name.toLowerCase() === "content-length" && value !== "0"),
        )
      )
        throw new GatewayError("gateway_request_mismatch");
      if (incoming.method !== c.req.raw.method)
        throw new GatewayError("gateway_request_mismatch");
      verifier ??= loadDoskaGatewayVerifier();
      const raw = c.req.raw;
      if (Object.keys(c.req.bodyCache).length)
        throw new GatewayError("gateway_raw_request_unavailable", 503);
      const body = await readBoundedBody(
        raw,
        options.maxBodyBytes ?? 2 * 1024 * 1024,
      );
      const now = options.now?.() ?? Date.now() / 1000;
      const claims: GatewayClaims = await verifier.verify(
        {
          method: incoming.method,
          rawUri: incoming.url,
          headers,
          body,
        },
        {
          requiredScope: options.requiredScope,
          now,
          maxBodyBytes: options.maxBodyBytes,
        },
      );
      const identity = await (options.resolveIdentity ?? resolveDoskaIdentity)(
        claims.sub,
      );
      const identityNow = options.now?.() ?? Date.now() / 1000;
      if (
        !identity ||
        identity.subject !== claims.sub ||
        !identity.active ||
        !Number.isFinite(identity.observedAt.getTime()) ||
        !Number.isFinite(identity.validUntil.getTime()) ||
        identity.observedAt.getTime() > identityNow * 1000 ||
        identity.validUntil.getTime() <= identityNow * 1000
      )
        throw new GatewayError("gateway_identity_unavailable", 403);
      // Rebuild after the bounded read, preserving the exact verified bytes for validators/handlers.
      c.req.raw = new Request(raw.url, {
        method: raw.method,
        headers: raw.headers,
        signal: raw.signal,
        ...(!["GET", "HEAD"].includes(raw.method) ? { body } : {}),
      });
      c.set("userId", identity.user.id);
      c.set("userEmail", identity.user.email);
      c.set("user", identity.user);
      c.set("session", null);
      c.set("apiKey", null);
      c.set("doskaIdentity", {
        subject: claims.sub,
        validUntil: identity.validUntil,
        csrfToken: claims.csrf_token,
        verified: true,
      });
    } catch (error) {
      if (error instanceof GatewayError)
        return c.json({ error: error.code }, error.status);
      return c.json({ error: "gateway_identity_service_unavailable" }, 503);
    }
    await next();
  });
}
