import { afterEach, expect, it, vi } from "vite-plus/test";
import { resourceLinksApi } from "./resource-links-api";
import { resourceLinksSchema } from "./resource-links-types";
vi.mock("./api", () => ({
  mutationOptions: async () => ({ headers: { "X-CSRF-Token": "test-csrf" } }),
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
afterEach(() => vi.unstubAllGlobals());
it("uses the same business key in header/body and independent link revision", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ version: 1, revision: 8, linkId: "l" }), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  await resourceLinksApi.mutate("p", "t", {
    operation: "attach",
    expectedRevision: 7,
    clientRequestId: "11111111-1111-4111-8111-111111111111",
    selection: {
      resourceId: "22222222-2222-4222-8222-222222222222",
      sourceKind: "platform",
    },
  });
  const [, options] = fetcher.mock.calls[0];
  const body = JSON.parse(options.body);
  expect(options.headers["Idempotency-Key"]).toBe(body.clientRequestId);
  expect(options.headers["X-CSRF-Token"]).toBe("test-csrf");
  expect(body.expectedRevision).toBe(7);
  expect(body).not.toHaveProperty("ref");
  expect(body).not.toHaveProperty("version");
});
it("rejects raw internal refs and unavailable snapshots", () => {
  expect(() =>
    resourceLinksSchema.parse({
      version: 1,
      revision: 0,
      links: [{ linkId: "l", ref: { source: "platform" } }],
    }),
  ).toThrow();
  expect(() =>
    resourceLinksSchema.parse({
      version: 1,
      revision: 0,
      links: [
        {
          linkId: "l",
          available: false,
          descriptor: { displayName: "secret", objectKind: "service" },
        },
      ],
    }),
  ).toThrow();
});

it("accepts only the Platform catalog permalink", () => {
  const value = {
    version: 1,
    revision: 1,
    links: [
      {
        linkId: "l",
        available: true,
        descriptor: {
          displayName: "Server",
          objectKind: "device",
          platformHref:
            "/#catalog?resourceId=11111111-1111-4111-8111-111111111111",
        },
      },
    ],
  };
  expect(resourceLinksSchema.safeParse(value).success).toBe(true);
  for (const href of [
    "javascript:alert(1)",
    "//other.example/path",
    "https://other.example/",
    "/#catalog?resourceId=wrong",
  ]) {
    value.links[0].descriptor.platformHref = href;
    expect(resourceLinksSchema.safeParse(value).success).toBe(false);
  }
});
