import { expect, type Page } from "@playwright/test";

export const localID = "22222222-2222-4222-8222-222222222222";
export const secondID = "33333333-3333-4333-8333-333333333333";
export const localInstance = (
  id = localID,
  state = "enabled",
  mode = "local",
) => ({
  id,
  module_id: "xray",
  name: id === localID ? "Office Xray" : "Second Xray",
  mode,
  desired_state: state,
  observed_state: state === "enabled" ? "running" : state,
});
export async function localProxyFixture(
  page: Page,
  initial = [localInstance()],
) {
  let items = initial;
  const calls: string[] = [];
  const writes: { path: string; body: any }[] = [];
  const drafts = new Map<string, any>();
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    calls.push(path);
    const match = path.match(
      /^\/modules\/([^/]+)\/xray\/(configuration|status)(\/validate)?$/,
    );
    if (match) {
      const id = match[1];
      let draft = drafts.get(id) ?? {
        revision: 0,
        ref: "",
        inbounds: [],
        outbound: { mode: "direct" },
        routing: "proxy_all",
      };
      if (req.method() !== "GET") {
        expect(req.headers()["x-csrf-token"]).toBe("proxy-csrf");
        const body = req.postDataJSON();
        writes.push({ path, body });
        if (match[3]) return route.fulfill({ json: { valid: true } });
        const config = body.configuration;
        draft = {
          ...config,
          revision: draft.revision + 1,
          ref: "44444444-4444-4444-8444-444444444444",
          outbound:
            config.outbound.mode === "imported"
              ? {
                  mode: "imported",
                  protocol: "vless",
                  server: "relay.example",
                  port: 443,
                }
              : config.outbound,
        };
        drafts.set(id, draft);
      }
      if (match[2] === "status")
        return route.fulfill({
          json: {
            state: items.find((item) => item.id === id)?.observed_state,
            version: "CI-pinned",
            inbounds: [
              {
                tag: "office",
                protocol: "socks",
                listen: "127.0.0.1",
                port: id === localID ? 1080 : 2080,
              },
            ],
            outbound: { mode: "direct" },
            routing: "proxy_all",
            counters: [
              { name: "inbound>>>office>>>traffic>>>uplink", value: 2048 },
            ],
          },
        });
      return route.fulfill({
        json: {
          editable: true,
          draft,
          applied: null,
          last_job_id: "",
          last_error: "",
          rolled_back: false,
        },
      });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "proxy-csrf",
      },
      "/modules": { items },
      "/modules/catalog": {
        local_available: true,
        items: [
          { id: "xray", name: "Xray", modes: ["local"], version: "CI-pinned" },
        ],
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
      "/dictionaries": {
        types: [],
        sites: [],
        environments: [],
        directions: [],
      },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  return {
    calls,
    writes,
    setItems: (next: typeof items) => {
      items = next;
    },
  };
}
export function expectNoLegacyCalls(calls: string[]) {
  expect(
    calls.filter(
      (path) => path.startsWith("/proxy-control") || path.startsWith("/edge/"),
    ),
  ).toEqual([]);
}
