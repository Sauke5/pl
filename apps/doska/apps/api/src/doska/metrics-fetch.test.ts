import { describe, expect, it, vi } from "vite-plus/test";
import { metricsFetch } from "./metrics-fetch";
describe("private metrics HTTP boundary", () => {
  it("is off by default, exact GET only, and available before directory readiness", async () => {
    const next = vi.fn(() => new Response(null, { status: 503 }));
    const render = vi.fn(() => "doska_directory_ready 0\n");
    expect(
      (
        await metricsFetch(
          false,
          render,
          next,
        )(new Request("http://api/metrics"), {})
      ).status,
    ).toBe(404);
    const enabled = metricsFetch(true, render, next);
    for (const [path, method] of [
      ["/metrics?x=1", "GET"],
      ["/metrics", "POST"],
      ["/metrics", "HEAD"],
    ])
      expect(
        (await enabled(new Request(`http://api${path}`, { method }), {}))
          .status,
      ).toBe(404);
    const response = await enabled(new Request("http://api/metrics"), {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("doska_directory_ready 0\n");
    expect(next).not.toHaveBeenCalled();
    expect((await enabled(new Request("http://api/healthz"), {})).status).toBe(
      503,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
