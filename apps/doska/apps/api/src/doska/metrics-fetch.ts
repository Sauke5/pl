/** Private operational endpoint; excluded from the Platform browser route manifest. */
export function metricsFetch<Bindings>(
  enabled: boolean,
  render: () => string,
  next: (request: Request, env: Bindings) => Response | Promise<Response>,
) {
  return (request: Request, env: Bindings): Response | Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/metrics") return next(request, env);
    if (!enabled || request.method !== "GET" || url.search)
      return new Response(null, { status: 404 });
    return new Response(render(), {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  };
}
