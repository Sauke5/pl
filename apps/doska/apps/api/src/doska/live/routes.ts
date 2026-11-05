import { OpenAPIHono } from "@hono/zod-openapi";
import type { DoskaHttpEnv } from "../http-identity";
import { isDoskaIntegrated } from "../mode";
import type { LiveListener } from "./listener";
import { LiveAdmission, openLiveStream } from "./stream";

// Mount under /api/doska only after the existing signed identity middleware.
// The process owner starts/stops one listener; constructing routes opens no DB connection.
export function createLiveRoutes(
  listener: LiveListener,
  admission = new LiveAdmission(),
) {
  const router = new OpenAPIHono<DoskaHttpEnv>();
  router.openAPIRegistry.registerPath({
    method: "get",
    path: "/events",
    operationId: "doskaLiveEvents",
    tags: ["Doska live"],
    summary: "Receive access-filtered task and project invalidations",
    description:
      "Signed Platform session required. No query parameters or replay. Reconnect requires fetching current state. Event contract: docs/contracts/live-events-v1.json.",
    responses: {
      200: {
        description:
          "Bounded SSE stream with ready, changed, personal and reset events",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
      400: { description: "Unsupported stream request" },
      401: { description: "Verified identity required" },
      404: { description: "Integrated mode disabled" },
      429: { description: "Stream admission limit reached" },
      503: { description: "Event listener unavailable" },
    },
  });
  return router.get("/events", async (c) => {
    if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
    const identity = c.get("doskaIdentity");
    if (!identity?.verified || !c.get("userId"))
      return c.json({ error: "gateway_identity_unavailable" }, 401);
    if (
      c.req.method !== "GET" ||
      new URL(c.req.url).search ||
      c.req.raw.headers.has("last-event-id")
    )
      return c.json({ error: "live_request_invalid" }, 400);
    return openLiveStream({
      request: c.req.raw,
      actorId: c.get("userId"),
      subject: identity.subject,
      listener,
      admission,
    });
  });
}
