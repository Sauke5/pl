import { afterEach, expect, it, vi } from "vite-plus/test";
afterEach(() => vi.unstubAllGlobals());
it("does not label the session context GET as an empty JSON request", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const { client, windowId } = await import("./hono");

  await client.doska.context.$get();

  const init = fetcher.mock.calls[0]![1] as RequestInit;
  expect(init.method).toBe("GET");
  expect(init.body).toBeUndefined();
  expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  expect(new Headers(init.headers).get("X-Kaneo-Window-Id")).toBe(windowId);
  expect(init.credentials).toBe("include");
});

it("preserves an explicitly supplied media type", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const { client } = await import("./hono");

  await client.doska.context.$get(undefined, {
    headers: { "Content-Type": "application/vnd.pl.context+json" },
  });

  const init = fetcher.mock.calls[0]![1] as RequestInit;
  expect(new Headers(init.headers).get("Content-Type")).toBe(
    "application/vnd.pl.context+json",
  );
});

it("preserves Hono Headers including CSRF on project creation", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response("{}", { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  const { client } = await import("./hono");
  await client.doska.projects.$post(
    { json: { name: "Pipi", slug: "Pupu", visibility: "department" } },
    { headers: { "X-CSRF-Token": "test-derived-token" } },
  );
  const init = fetcher.mock.calls[0]![1] as RequestInit;
  expect(new Headers(init.headers).get("X-CSRF-Token")).toBe(
    "test-derived-token",
  );
  expect(new Headers(init.headers).get("Content-Type")).toBe(
    "application/json",
  );
  expect(init.credentials).toBe("include");
});
