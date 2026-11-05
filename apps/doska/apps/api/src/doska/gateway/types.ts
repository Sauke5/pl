export type DoskaScope = "doska:read" | "doska:write" | "doska:realtime";

export type GatewayClaims = Readonly<{
  v: 2;
  aud: "doska";
  iat: number;
  exp: number;
  nonce: string;
  sub: string;
  name: string;
  /** Platform fact only. Never grants Doska project or administration access. */
  admin: boolean;
  scopes: readonly DoskaScope[];
  method: string;
  uri: string;
  content_type: string;
  body_sha256: string;
  idempotency_key: string;
  source_ip: string;
  csrf_token: string;
  csrf_verified: boolean;
}>;

export interface NonceStore {
  /**
   * Atomically reserve (audience, nonce) across ALL processes/replicas until
   * expiresAt (Unix seconds, inclusive). Do not evict live reservations.
   * A handler failure must not release the reservation.
   */
  reserve(input: {
    audience: "doska";
    nonce: string;
    expiresAt: number;
    now: number;
  }): Promise<"reserved" | "replay" | "unavailable">;
}

export type GatewayRequest = {
  method: string;
  /** Exact incoming Node raw req.url, BEFORE URL parsing or normalization. */
  rawUri: string;
  /** Original pairs from rawHeaders; Headers loses duplicate field evidence. */
  headers: readonly (readonly [string, string])[];
  body: Uint8Array;
};

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 401 | 403 | 409 | 413 | 503 = 401,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}
