import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { DoskaHttpEnv } from "../http-identity";
import { LiveListener } from "./listener";
import { createLiveRoutes } from "./routes";
afterEach(() => vi.unstubAllEnvs());
it("does not expose live in standalone mode or without verified Platform identity", async () => {
  const router = createLiveRoutes(new LiveListener());
  vi.stubEnv("DOSKA_AUTH_MODE", "standalone");
  expect((await router.request("/events")).status).toBe(404);
  vi.stubEnv("DOSKA_AUTH_MODE", "platform");
  expect((await router.request("/events")).status).toBe(401);
});
it("rejects HEAD, arbitrary query and replay headers before opening database access", async () => {
  vi.stubEnv("DOSKA_AUTH_MODE", "platform");
  const router = new Hono<DoskaHttpEnv>();
  router.use("*", async (c, next) => {
    c.set("userId", "actor");
    c.set("doskaIdentity", {
      verified: true,
      subject: "subject",
      validUntil: new Date(Date.now() + 60000),
      csrfToken: "synthetic",
    });
    await next();
  });
  router.route("/", createLiveRoutes(new LiveListener()));
  expect((await router.request("/events", { method: "HEAD" })).status).toBe(
    400,
  );
  expect((await router.request("/events?x=1")).status).toBe(400);
  expect(
    (await router.request("/events", { headers: { "Last-Event-ID": "" } }))
      .status,
  ).toBe(400);
});
