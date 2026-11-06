import type { Page } from "@playwright/test";
import type { ConfigurationHistory } from "../../src/ConnectionDetails";
import type { Integration, Resource } from "../../src/types";
import { settingsWorkspaceFixture } from "./settingsWorkspace";

// UI adapter fixture only. Provider ingestion, latest-receipt selection and
// authorization are covered independently by the Go tests.
export const oxidizedID = "oxidized-main";
export const resourceOneID = "43cf72ec-d997-4a4b-a03a-4b9bbf7b8151";
export const resourceTwoID = "43cf72ec-d997-4a4b-a03a-4b9bbf7b8152";
const now = "2026-10-26T09:15:00Z";
const revision = "abcde12345abcde12345abcde12345abcde12345";

export async function relationsExchangeFixture(
  page: Page,
  options: { manyIntegrations?: boolean } = {},
) {
  const base = await settingsWorkspaceFixture(page, options);
  const oxidized: Integration = {
    id: oxidizedID,
    revision: 3,
    name: "История конфигураций сети",
    kind: "oxidized",
    url: "https://oxidized.example.test",
    enabled: true,
    poll_seconds: 120,
    timeout_seconds: 10,
    concurrency: 1,
    secret_ref: "",
    config: {
      gitea_repository_url: "https://git.example.test/network/configurations",
      gitea_branch: "main",
      node_bindings: JSON.stringify({ "lab/switch-one": resourceOneID }),
    },
    status: "connected",
    error: "",
    last_success: now,
    last_attempt: now,
    capabilities: ["configuration-history"],
  };
  base.integrations.push(oxidized);
  const resources: Resource[] = [
    [resourceOneID, "Коммутатор один"],
    [resourceTwoID, "Коммутатор два"],
  ].map(([id, name]) => ({
    id,
    revision: 1,
    name,
    description: "Проверочное оборудование",
    type: "Сетевое устройство",
    url: "",
    endpoints: [],
    ip: "",
    hostname: "",
    aliases: [],
    directions: ["Сети"],
    site: "Лаборатория",
    environment: "Test",
    tags: [],
    relations: [],
    links: [],
    source: "manual",
    external_ids: [],
    check: { kind: "", target: "", interval_seconds: 60 },
    operations: [],
    executor_target: "",
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  }));
  const configuration: ConfigurationHistory = {
    integration_id: oxidizedID,
    observed_at: now,
    last_success_at: now,
    source_status: "partial",
    stale: false,
    nodes: [
      {
        key: "lab/switch-one",
        name: "Коммутатор один",
        group: "Лаборатория",
        collection_status: "success",
        last_successful_collection_at: "2026-10-26T08:00:00Z",
        last_change_at: "2026-10-25T10:00:00Z",
        revision,
        history_url:
          "https://git.example.test/network/configurations/commits/branch/main/lab/switch-one",
        diff_url: `https://git.example.test/network/configurations/commit/${revision}`,
        resource_id: resourceOneID,
      },
      {
        key: "lab/switch-two",
        name: "Коммутатор два",
        group: "Лаборатория",
        collection_status: "never",
        last_successful_collection_at: null,
        last_change_at: null,
        revision: "",
        history_url: "",
        diff_url: "",
        error: "История узла временно недоступна",
      },
    ],
  };
  const requests: { method: string; path: string }[] = [];
  const state = {
    base,
    oxidized,
    resources,
    configuration,
    requests,
  };
  await page.route("**/doska/api/doska/catalog/task-links", (route) =>
    route.fulfill({ json: { version: 1, items: [], nextCursor: null } }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    requests.push({ method: request.method(), path });
    if (path === "/stream")
      return route.fulfill({
        contentType: "text/event-stream",
        body: "retry: 60000\n\n",
      });
    if (path === "/resources") return route.fulfill({ json: resources });
    if (/^\/resources\/[^/]+\/inventory$/.test(path))
      return route.fulfill({ json: { sources: [] } });
    const integrationHistory =
      /^\/integrations\/([^/]+)\/configuration-history$/.exec(path);
    if (integrationHistory)
      return route.fulfill({
        json:
          integrationHistory[1] === oxidizedID
            ? state.configuration
            : {
                integration_id: integrationHistory[1],
                observed_at: null,
                last_success_at: null,
                source_status: "unavailable",
                stale: true,
                nodes: [],
              },
      });
    const resourceHistory =
      /^\/resources\/([^/]+)\/configuration-history$/.exec(path);
    if (resourceHistory)
      return route.fulfill({
        json:
          resourceHistory[1] === resourceOneID
            ? [
                {
                  ...state.configuration,
                  nodes: state.configuration.nodes.filter(
                    (node) => node.resource_id === resourceOneID,
                  ),
                },
              ]
            : [],
      });
    const resource = /^\/resources\/([^/]+)$/.exec(path);
    if (resource) {
      const item = resources.find((value) => value.id === resource[1]);
      return item
        ? route.fulfill({ json: item })
        : route.fulfill({ status: 404, json: { message: "Ресурс не найден" } });
    }
    return route.fallback();
  });
  return state;
}
