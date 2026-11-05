import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import fixtures from "./fixtures/doska-gateway-v2-vectors.json";
import { DoskaGatewayVerifier } from "./verifier";
import { type DoskaScope, type GatewayRequest, type NonceStore } from "./types";

const key = Buffer.from(fixtures.key_hex, "hex");
const get = fixtures.vectors[0]!;
const post = fixtures.vectors[1]!;
function request(vector = get): GatewayRequest {
  return {
    method: vector.request.method,
    rawUri: vector.upstream_uri,
    headers: Object.entries(vector.request.headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
    body: Buffer.from(vector.request.body_utf8),
  };
}
function signed(json: string, base = request()): GatewayRequest {
  const assertion = Buffer.from(json).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`pl-gateway-v2\n${assertion}`)
    .digest("base64url");
  return {
    ...base,
    headers: [
      ...base.headers.filter(
        ([name]) => !name.toLowerCase().startsWith("x-pl-"),
      ),
      ["X-PL-Gateway-Assertion", assertion],
      ["X-PL-Gateway-Signature", signature],
    ],
  };
}
function changed(patch: Record<string, unknown>, vector = get) {
  return signed(
    JSON.stringify({ ...vector.payload, ...patch }),
    request(vector),
  );
}
function verifier() {
  const seen = new Set<string>();
  const reserve = vi.fn<NonceStore["reserve"]>(async ({ audience, nonce }) => {
    const key = `${audience}:${nonce}`;
    if (seen.has(key)) return "replay";
    seen.add(key);
    return "reserved";
  });
  return { verify: new DoskaGatewayVerifier(key, { reserve }), reserve };
}
const options = { now: get.now, requiredScope: "doska:read" as DoskaScope };

describe("canonical Go / TypeScript fixtures", () => {
  it("pins the exact approved public fixture bytes", () => {
    const bytes = readFileSync(
      new URL("./fixtures/doska-gateway-v2-vectors.json", import.meta.url),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "27cfacd580aae63e3baedd837daf0e6e55fff76c45b08c8e4075c06361aa7b11",
    );
    expect(fixtures.test_only).toBe(true);
  });
  for (const vector of fixtures.vectors) {
    it(vector.name, async () => {
      const { verify, reserve } = verifier();
      const claims = await verify.verify(request(vector), {
        now: vector.now,
        requiredScope: `doska:${vector.route_kind}` as DoskaScope,
      });
      expect(claims).toEqual(vector.payload);
      expect(claims.admin).toBe(false);
      expect(
        createHmac("sha256", key).update(vector.hmac_input_ascii).digest("hex"),
      ).toBe(vector.expected_hmac_hex);
      expect(
        createHmac("sha256", fixtures.portal_csrf_utf8)
          .update("pl-gateway-csrf-v1\ndoska")
          .digest("base64url"),
      ).toBe(claims.csrf_token);
      if (vector.route_kind === "write")
        expect(reserve).toHaveBeenCalledWith({
          audience: "doska",
          nonce: claims.nonce,
          now: vector.now,
          expiresAt: claims.exp + 5,
        });
      else expect(reserve).not.toHaveBeenCalled();
    });
  }
});

describe("strict authenticated claims", () => {
  it.each([
    ["version", { v: true }],
    ["audience", { aud: "directory" }],
    ["admin type", { admin: "true" }],
    ["unknown field", { extra: "x" }],
    ["empty subject", { sub: "" }],
    ["long utf8 subject", { sub: "я".repeat(129) }],
    ["control", { name: "bad\u0085name" }],
    ["surrogate", { name: "bad\ud800" }],
    ["bad IP", { source_ip: "1.2.3.999" }],
    ["zoned IP", { source_ip: "fe80::1%eth0" }],
    ["nonascii URI", { uri: "/doska/api/я" }],
    ["bad digest", { body_sha256: "A".repeat(64) }],
    ["short nonce", { nonce: "YQ" }],
    ["padded nonce", { nonce: `${get.payload.nonce}=` }],
    ["short csrf", { csrf_token: "YQ" }],
    ["bad csrf type", { csrf_verified: 0 }],
    ["unknown scope", { scopes: ["doska:admin"] }],
    ["duplicate scope", { scopes: ["doska:read", "doska:read"] }],
    ["unsorted scopes", { scopes: ["doska:write", "doska:read"] }],
    ["scopes type", { scopes: "doska:read" }],
    ["future", { iat: get.now + 6, exp: get.now + 30 }],
    ["expired", { iat: get.now - 40, exp: get.now - 6 }],
    ["long TTL", { exp: get.now + 31 }],
    ["zero TTL", { exp: get.now }],
  ])("rejects %s", async (_name, patch) => {
    const { verify, reserve } = verifier();
    await expect(
      verify.verify(changed(patch as Record<string, unknown>), options),
    ).rejects.toMatchObject({ status: 401 });
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    get.canonical_json_utf8.replace('"v":2', '"v":2,"v":2'),
    get.canonical_json_utf8.replace('"v":2', '"v":2,"\\u0076":2'),
    get.canonical_json_utf8.replace('"v":2', '"v":2.0'),
    get.canonical_json_utf8.replace('"v":2', '"v":2e0'),
    get.canonical_json_utf8.replace('"v":2,', ""),
    "\uFEFF" + get.canonical_json_utf8,
    "[]",
    "null",
    "{",
  ])("rejects malformed, duplicate or missing JSON claims", async (json) => {
    await expect(
      verifier().verify.verify(signed(json), options),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("verifies original encoded bytes before JSON parsing", async () => {
    const req = signed("{");
    const headers = req.headers.map(
      ([name, value]) =>
        [
          name,
          name === "X-PL-Gateway-Signature"
            ? Buffer.alloc(32).toString("base64url")
            : value,
        ] as const,
    );
    await expect(
      verifier().verify.verify({ ...req, headers }, options),
    ).rejects.toMatchObject({ code: "invalid_gateway_signature" });
  });

  it("accepts field order changes and signed escaped characters", async () => {
    const reordered = Object.fromEntries(Object.entries(get.payload).reverse());
    expect(
      (
        await verifier().verify.verify(
          signed(JSON.stringify(reordered)),
          options,
        )
      ).sub,
    ).toBe(get.payload.sub);
  });

  it("rejects noncanonical base64url even when signed", async () => {
    const encoded = Buffer.from(get.canonical_json_utf8).toString("base64url");
    // A padding suffix is rejected rather than decoded permissively by Buffer.
    const assertion = `${encoded}=`;
    const signature = createHmac("sha256", key)
      .update(`pl-gateway-v2\n${assertion}`)
      .digest("base64url");
    await expect(
      verifier().verify.verify(
        {
          ...request(),
          headers: [
            ["X-PL-Gateway-Assertion", assertion],
            ["X-PL-Gateway-Signature", signature],
          ],
        },
        options,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("binding and authority", () => {
  it.each([
    "X-PL-Gateway-Assertion",
    "X-PL-Gateway-Signature",
    "Content-Type",
    "Idempotency-Key",
    "X-CSRF-Token",
    "Content-Encoding",
  ])(
    "rejects duplicate %s including differently cased fields",
    async (name) => {
      const req = request(post);
      const original = req.headers.filter(
        ([key]) => key.toLowerCase() !== name.toLowerCase(),
      );
      await expect(
        verifier().verify.verify(
          {
            ...req,
            headers: [...original, [name, "x"], [name.toLowerCase(), "x"]],
          },
          options,
        ),
      ).rejects.toMatchObject({ code: "duplicate_gateway_header" });
    },
  );
  it.each(["Cookie", "Authorization", "X-User", "X-PL-Admin"])(
    "rejects alternate identity %s",
    async (name) => {
      const req = request();
      await expect(
        verifier().verify.verify(
          { ...req, headers: [...req.headers, [name, "x"]] },
          options,
        ),
      ).rejects.toMatchObject({ status: 401 });
    },
  );
  it.each([
    { method: "POST" },
    { rawUri: get.upstream_uri.replace("%2F", "/") },
    { rawUri: "/api/search?q=a%2Fb&q=%D0%98%D0%B2%D0%B0%D0%BD" },
    { rawUri: get.external_uri },
    { body: Buffer.from(" ") },
  ])("binds exact method, raw URI and body", async (patch) => {
    await expect(
      verifier().verify.verify({ ...request(), ...patch }, options),
    ).rejects.toMatchObject({ status: 401 });
  });
  it.each(["Content-Type", "Idempotency-Key", "Content-Encoding"])(
    "binds %s",
    async (name) => {
      const req = request(post);
      await expect(
        verifier().verify.verify(
          {
            ...req,
            headers: [
              ...req.headers.filter(
                ([key]) => key.toLowerCase() !== name.toLowerCase(),
              ),
              [name, "changed"],
            ],
          },
          options,
        ),
      ).rejects.toMatchObject({ status: 401 });
    },
  );
  it("does not grant admin users missing route scopes", async () => {
    await expect(
      verifier().verify.verify(
        changed({ admin: true, scopes: ["doska:read"] }),
        { ...options, requiredScope: "doska:write" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      verifier().verify.verify(
        changed({ admin: true, scopes: ["doska:read"] }, post),
        options,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("requires realtime scope explicitly at a WS handshake", async () => {
    const req = changed({ scopes: ["doska:read"], uri: "/doska/api/ws/user" });
    await expect(
      verifier().verify.verify(
        { ...req, rawUri: "/api/ws/user" },
        { ...options, requiredScope: "doska:realtime" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const full = changed({ uri: "/doska/api/ws/user" });
    expect(
      (
        await verifier().verify.verify(
          { ...full, rawUri: "/api/ws/user" },
          { ...options, requiredScope: "doska:realtime" },
        )
      ).sub,
    ).toBe(get.payload.sub);
  });
  it("ignores attacker X-Original-URI and uses actual upstream URI", async () => {
    const req = request();
    await expect(
      verifier().verify.verify(
        {
          ...req,
          rawUri: "/api/other",
          headers: [...req.headers, ["X-Original-URI", get.external_uri]],
        },
        options,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("enforces body bounds", async () => {
    await expect(
      verifier().verify.verify(request(post), { ...options, maxBodyBytes: 1 }),
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe("CSRF and durable replay boundary", () => {
  it("requires both signed verification and matching forwarded token", async () => {
    const { verify, reserve } = verifier();
    await expect(
      verify.verify(changed({ csrf_verified: false }, post), options),
    ).rejects.toMatchObject({ status: 403 });
    const req = request(post);
    await expect(
      verify.verify(
        {
          ...req,
          headers: req.headers.filter(([name]) => name !== "X-CSRF-Token"),
        },
        options,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(reserve).not.toHaveBeenCalled();
  });
  it("rejects safe requests with body or csrf_verified", async () => {
    await expect(
      verifier().verify.verify(changed({ csrf_verified: true }), options),
    ).rejects.toMatchObject({ status: 403 });
    const body = Buffer.from("x");
    const req = changed({
      body_sha256: createHash("sha256").update(body).digest("hex"),
    });
    await expect(
      verifier().verify.verify({ ...req, body }, options),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("admits exactly one concurrent unsafe request and keeps consumed nonce", async () => {
    const { verify } = verifier();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => verify.verify(request(post), options)),
    );
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ status: 409 });
    await expect(verify.verify(request(post), options)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("does not reserve safe requests", async () => {
    const { verify, reserve } = verifier();
    await verify.verify(request(), options);
    await verify.verify(request(), options);
    expect(reserve).not.toHaveBeenCalled();
  });
  it("fails closed on nonce store exhaustion and errors", async () => {
    for (const reserve of [
      async () => "unavailable" as const,
      async () => {
        throw new Error("database error");
      },
    ]) {
      await expect(
        new DoskaGatewayVerifier(key, { reserve }).verify(
          request(post),
          options,
        ),
      ).rejects.toMatchObject({
        status: 503,
        message: "gateway_nonce_store_unavailable",
      });
    }
  });
  it("rejects invalid key lengths and isolates the copied key", async () => {
    expect(
      () =>
        new DoskaGatewayVerifier(Buffer.alloc(31), {
          reserve: async () => "reserved",
        }),
    ).toThrow("32 raw bytes");
    const mutableKey = Buffer.from(key);
    const verify = new DoskaGatewayVerifier(mutableKey, {
      reserve: async () => "reserved",
    });
    mutableKey.fill(0);
    await expect(verify.verify(request(), options)).resolves.toMatchObject({
      sub: get.payload.sub,
    });
  });
});

it("rejects authenticated invalid UTF-8 instead of replacement decoding", async () => {
  const bytes = Buffer.concat([
    Buffer.from('{"name":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  const assertion = bytes.toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`pl-gateway-v2\n${assertion}`)
    .digest("base64url");
  await expect(
    verifier().verify.verify(
      {
        ...request(),
        headers: [
          ["X-PL-Gateway-Assertion", assertion],
          ["X-PL-Gateway-Signature", signature],
        ],
      },
      options,
    ),
  ).rejects.toMatchObject({ code: "invalid_gateway_json" });
});

it("rejects nonzero base64url padding bits in a signature", async () => {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const req = request();
  const headers = req.headers.map(([name, value]) => {
    if (name !== "X-PL-Gateway-Signature") return [name, value] as const;
    const last = alphabet.indexOf(value.at(-1)!);
    return [name, value.slice(0, -1) + alphabet[last + 1]] as const;
  });
  await expect(
    verifier().verify.verify({ ...req, headers }, options),
  ).rejects.toMatchObject({ code: "invalid_gateway_encoding" });
});

it.each([
  "/api//task",
  "/api/../task",
  "/api/./task",
  "/api/%74ask",
  "/api/ta\\sk",
  "/api/task#fragment",
  "/other/task",
])(
  "rejects even correctly signed ambiguous upstream path %s",
  async (rawUri) => {
    const req = changed({ uri: `/doska${rawUri}` });
    await expect(
      verifier().verify.verify({ ...req, rawUri }, options),
    ).rejects.toMatchObject({ code: "gateway_request_mismatch" });
  },
);

describe("streamed upload verification", () => {
  const bytes = Buffer.from("received file bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  function upload() {
    const base = request(post);
    const rawUri = "/api/doska/attachment-uploads/upload-id/content";
    return signed(
      JSON.stringify({
        ...post.payload,
        method: "PUT",
        uri: `/doska${rawUri}`,
        content_type: "application/octet-stream",
        body_sha256: digest,
      }),
      {
        ...base,
        method: "PUT",
        rawUri,
        body: bytes,
        headers: base.headers.map(([name, value]) => [
          name,
          name.toLowerCase() === "content-type"
            ? "application/octet-stream"
            : value,
        ]),
      },
    );
  }
  it("reserves the nonce before any body is read and rejects racing/replayed headers", async () => {
    const { verify, reserve } = verifier();
    const { body: _, ...headersOnly } = upload();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        verify.verifyUploadHeaders(headersOnly, options),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: "gateway_replay",
          status: 409,
        });
    expect(reserve).toHaveBeenCalledTimes(8);
    const accepted = results.find((result) => result.status === "fulfilled")!;
    if (accepted.status !== "fulfilled")
      throw new Error("missing accepted headers");
    expect(() =>
      verify.verifyUploadBody(accepted.value, {
        size: bytes.length,
        sha256: "0".repeat(64),
      }),
    ).toThrow("gateway_request_mismatch");
    expect(
      verify.verifyUploadBody(accepted.value, {
        size: bytes.length,
        sha256: digest,
      }),
    ).toBe(accepted.value);
    expect(reserve).toHaveBeenCalledTimes(8);
    await expect(
      verify.verifyUploadHeaders(headersOnly, options),
    ).rejects.toMatchObject({ code: "gateway_replay" });
  });
  it.each([
    "signature",
    "csrf",
    "path",
    "method",
    "type",
    "encoding",
    "idempotency",
  ])("rejects changed %s before consuming nonce", async (field) => {
    const req = upload();
    if (field === "path") req.rawUri += "/other";
    else if (field === "method") req.method = "POST";
    else {
      const names: Record<string, string> = {
        signature: "x-pl-gateway-signature",
        csrf: "x-csrf-token",
        type: "content-type",
        encoding: "content-encoding",
        idempotency: "idempotency-key",
      };
      const name = names[field]!;
      req.headers = [
        ...req.headers.filter(([key]) => key.toLowerCase() !== name),
        [name, "invalid"],
      ];
    }
    const { verify, reserve } = verifier();
    await expect(
      verify.verifyUploadHeaders(req, options),
    ).rejects.toMatchObject({ name: "GatewayError" });
    expect(reserve).not.toHaveBeenCalled();
  });
  it.each([
    { aud: "other-service" },
    { scopes: ["doska:read"] },
    { iat: options.now - 120, exp: options.now - 90 },
  ])(
    "rejects invalid upload claims %j before reserving a nonce",
    async (patch) => {
      const req = upload();
      const encoded = req.headers.find(
        ([name]) => name.toLowerCase() === "x-pl-gateway-assertion",
      )![1];
      const claims = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      const { verify, reserve } = verifier();
      await expect(
        verify.verifyUploadHeaders(
          signed(JSON.stringify({ ...claims, ...patch }), req),
          options,
        ),
      ).rejects.toMatchObject({ name: "GatewayError" });
      expect(reserve).not.toHaveBeenCalled();
    },
  );
  it("accepts only signed PUT octet-stream uploads", async () => {
    await expect(
      verifier().verify.verifyUploadHeaders(request(post), options),
    ).rejects.toMatchObject({ code: "gateway_request_mismatch" });
    await expect(
      verifier().verify.verifyUploadHeaders(request(), options),
    ).rejects.toMatchObject({ code: "gateway_request_mismatch" });
  });
  it("bounds the actual bytes and validates their computed digest independently of expiry", async () => {
    const { verify } = verifier();
    const claims = await verify.verifyUploadHeaders(upload(), options);
    vi.spyOn(Date, "now").mockReturnValue((claims.exp + 120) * 1000);
    try {
      expect(
        verify.verifyUploadBody(claims, {
          size: 25 * 1024 * 1024,
          sha256: digest,
        }),
      ).toBe(claims);
      expect(() =>
        verify.verifyUploadBody(claims, {
          size: 25 * 1024 * 1024 + 1,
          sha256: digest,
        }),
      ).toThrow("request_body_too_large");
      expect(() =>
        verify.verifyUploadBody(
          claims,
          { size: bytes.length, sha256: digest },
          { maxBodyBytes: 1 },
        ),
      ).toThrow("request_body_too_large");
      for (const size of [-1, Number.NaN, Infinity, 1.5])
        expect(() =>
          verify.verifyUploadBody(claims, { size, sha256: digest }),
        ).toThrow("gateway_request_mismatch");
      expect(() =>
        verify.verifyUploadBody(claims, {
          size: bytes.length,
          sha256: "not-a-digest",
        }),
      ).toThrow("gateway_request_mismatch");
      expect(() =>
        verify.verifyUploadBody(
          claims,
          { size: bytes.length, sha256: digest },
          { maxBodyBytes: 26 * 1024 * 1024 },
        ),
      ).toThrow("invalid_gateway_configuration");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
