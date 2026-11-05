import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import fixtures from "./gateway/fixtures/doska-gateway-v2-vectors.json";
import { DoskaGatewayVerifier } from "./gateway/verifier";
import {
  createDoskaHttpIdentity,
  loadDoskaGatewayVerifier,
  type DoskaHttpEnv,
  type ResolvedDoskaIdentity,
} from "./http-identity";

const get = fixtures.vectors[0]!;
const post = fixtures.vectors[1]!;
function identity(): ResolvedDoskaIdentity {
  return {
    subject: get.payload.sub,
    active: true,
    observedAt: new Date((get.now - 10) * 1000),
    validUntil: new Date((get.now + 120) * 1000),
    user: {
      id: "local-stable-id",
      email: "local@example.test",
      name: "Local",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}
async function run(
  options: {
    vector?: typeof get;
    uri?: string;
    extraHeaders?: string[];
    maxBodyBytes?: number;
    resolveIdentity?: (
      subject: string,
    ) => Promise<ResolvedDoskaIdentity | null>;
    nonceUnavailable?: boolean;
  } = {},
) {
  const vector = options.vector ?? get;
  const resolveIdentity =
    options.resolveIdentity ?? vi.fn(async () => identity());
  const app = new Hono<DoskaHttpEnv>();
  app.use(
    "*",
    createDoskaHttpIdentity({
      requiredScope: vector === post ? "doska:write" : "doska:read",
      maxBodyBytes: options.maxBodyBytes,
      verifier: new DoskaGatewayVerifier(Buffer.from(fixtures.key_hex, "hex"), {
        reserve: async () => {
          if (options.nonceUnavailable) throw new Error("private DSN");
          return "reserved";
        },
      }),
      now: () => vector.now,
      resolveIdentity,
    }),
  );
  app.all("*", async (c) =>
    c.json({
      id: c.get("userId"),
      email: c.get("userEmail"),
      verified: c.get("doskaIdentity").verified,
      session: c.get("session"),
      apiKey: c.get("apiKey"),
      body: await c.req.text(),
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    return await new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve, reject) => {
        const headers = Object.entries(vector.request.headers).flatMap(
          ([name, value]) => (typeof value === "string" ? [name, value] : []),
        );
        const req = request(
          {
            hostname: "127.0.0.1",
            port: (server.address() as AddressInfo).port,
            method: vector.request.method,
            path: options.uri ?? vector.upstream_uri,
            headers: [
              "Host",
              "localhost",
              "Connection",
              "close",
              ...headers,
              ...(options.extraHeaders ?? []),
            ],
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode!, body: JSON.parse(body) });
              } catch {
                reject(new Error(`Non-JSON response ${res.statusCode}`));
              }
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(vector.request.body_utf8);
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("Doska raw HTTP identity boundary", () => {
  it("verifies real Node raw repeated/encoded query and resolves only stable subject", async () => {
    const resolveIdentity = vi.fn(async () => identity());
    const result = await run({ resolveIdentity });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      id: "local-stable-id",
      email: "local@example.test",
      verified: true,
      apiKey: null,
      session: null,
    });
    expect(resolveIdentity).toHaveBeenCalledExactlyOnceWith(get.payload.sub);
  });
  it("rejects changed raw query ordering/encoding", async () => {
    expect((await run({ uri: `${get.upstream_uri}&extra=1` })).status).toBe(
      401,
    );
  });
  it("rejects duplicate raw assertion even if Headers would merge it", async () => {
    const result = await run({
      extraHeaders: [
        "X-PL-Gateway-Assertion",
        get.request.headers["X-PL-Gateway-Assertion"]!,
      ],
    });
    expect(result).toEqual({
      status: 401,
      body: { error: "duplicate_gateway_header" },
    });
  });
  it("rejects GET body framing hidden by the Fetch adapter", async () => {
    expect((await run({ extraHeaders: ["Content-Length", "1"] })).status).toBe(
      401,
    );
  });
  it("preserves signed Unicode bytes for downstream body parsing", async () => {
    const result = await run({ vector: post });
    expect(result.status).toBe(200);
    expect(result.body.body).toBe(post.request.body_utf8);
  });
  it("bounds streamed bytes independently of Content-Length", async () => {
    expect((await run({ vector: post, maxBodyBytes: 5 })).status).toBe(413);
  });
  it.each(["unknown", "disabled", "stale", "future", "wrong-subject"])(
    "fails closed for %s identity",
    async (state) => {
      const resolveIdentity = async () => {
        if (state === "unknown") return null;
        const row = identity();
        if (state === "disabled") row.active = false;
        if (state === "stale") row.validUntil = new Date(get.now * 1000);
        if (state === "future") row.observedAt = new Date((get.now + 1) * 1000);
        if (state === "wrong-subject") row.subject = "other";
        return row;
      };
      expect((await run({ resolveIdentity })).status).toBe(403);
    },
  );
  it("sanitizes identity and replay storage errors", async () => {
    const result = await run({
      resolveIdentity: async () => {
        throw new Error("private DSN");
      },
    });
    expect(result).toEqual({
      status: 503,
      body: { error: "gateway_identity_service_unavailable" },
    });
    expect((await run({ vector: post, nonceUnavailable: true })).body).toEqual({
      error: "gateway_nonce_store_unavailable",
    });
  });
  it("rejects request without raw Node bindings rather than trusting normalized headers", async () => {
    const app = new Hono<DoskaHttpEnv>();
    app.use("*", createDoskaHttpIdentity({ requiredScope: "doska:read" }));
    app.get("*", (c) => c.text("should not run"));
    const result = await app.request("http://localhost/api/test");
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "gateway_raw_request_unavailable",
    });
  });
  it("sanitizes key-file errors", () => {
    expect(() =>
      loadDoskaGatewayVerifier("/does/not/exist/private-key"),
    ).toThrow("gateway_configuration_unavailable");
  });
});
