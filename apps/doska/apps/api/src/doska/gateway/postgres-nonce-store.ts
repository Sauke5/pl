import { sql } from "drizzle-orm";
import db from "../../database";
import type { NonceStore } from "./types";

/** One atomic statement arbitrates replay across all workers and replicas. */
export class PostgresNonceStore implements NonceStore {
  constructor(private readonly database: Pick<typeof db, "execute"> = db) {}

  async reserve(input: Parameters<NonceStore["reserve"]>[0]) {
    const { audience, nonce, expiresAt, now } = input;
    if (
      audience !== "doska" ||
      !/^[A-Za-z0-9_-]{22,86}$/.test(nonce) ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isFinite(now) ||
      expiresAt < now
    ) {
      return "unavailable" as const;
    }
    const result = await this.database.execute(sql`
      INSERT INTO doska_gateway_nonce (audience, nonce, expires_at)
      VALUES (${audience}, ${nonce}, ${new Date(expiresAt * 1000)})
      ON CONFLICT (audience, nonce) DO UPDATE
      SET expires_at = EXCLUDED.expires_at
      WHERE doska_gateway_nonce.expires_at < ${new Date(now * 1000)}
      RETURNING nonce
    `);
    return result.rows.length === 1
      ? ("reserved" as const)
      : ("replay" as const);
  }

  /** Call periodically; only expired reservations are eligible for removal. */
  async pruneExpired(now = new Date(), limit = 1000): Promise<number> {
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10000
    ) {
      throw new RangeError("Invalid replay cleanup bounds");
    }
    const result = await this.database.execute(sql`
      WITH expired AS (
        SELECT audience, nonce FROM doska_gateway_nonce
        WHERE expires_at < ${now}
        ORDER BY expires_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM doska_gateway_nonce AS target USING expired
      WHERE target.audience = expired.audience AND target.nonce = expired.nonce
      RETURNING target.nonce
    `);
    return result.rows.length;
  }
}
