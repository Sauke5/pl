import type { Page, Route } from "@playwright/test";
import type { Dictionaries, Integration, Settings } from "../../src/types";

// Deterministic UI contract fixture. Database transactions, provider probes and
// authorization are exercised by the Go integration tests, not these routes.
const timestamp = "2026-10-26T09:15:00Z";

export type WorkspaceRequest = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
};

type HistoryEntry = {
  id: string;
  kind: string;
  object_id: string;
  object_name: string;
  action: string;
  actor: string;
  actor_name: string;
  created_at: string;
  revision: number;
  detailed: boolean;
  changes: { field: string; label: string; before: unknown; after: unknown }[];
};

export async function settingsWorkspaceFixture(
  page: Page,
  options: { manyIntegrations?: boolean; empty?: boolean } = {},
) {
  const integrations: Integration[] = options.empty
    ? []
    : [
        {
          id: "prometheus-main",
          revision: 3,
          name: "Основной Prometheus",
          kind: "prometheus",
          url: "https://metrics.example.test",
          enabled: true,
          poll_seconds: 60,
          timeout_seconds: 10,
          concurrency: 2,
          secret_ref: "",
          config: { discovery_enabled: "true", include_job: "linux" },
          status: "connected",
          error: "",
          last_success: timestamp,
          last_attempt: timestamp,
          capabilities: ["discovery"],
        },
        {
          id: "netbox-main",
          revision: 2,
          name: "NetBox инфраструктуры",
          kind: "netbox",
          url: "https://inventory.example.test",
          enabled: true,
          poll_seconds: 120,
          timeout_seconds: 10,
          concurrency: 1,
          secret_ref: "env:PORTAL_SECRET_NETBOX",
          config: { public_url: "https://inventory.example.test" },
          status: "error",
          error: "Источник временно недоступен",
          last_success: "2026-10-26T08:00:00Z",
          last_attempt: timestamp,
          capabilities: ["inventory"],
        },
      ];
  if (options.manyIntegrations) {
    for (let index = 1; index <= 36; index += 1) {
      integrations.push({
        ...integrations[0],
        id: `source-${index}`,
        name: `Источник ${String(index).padStart(2, "0")} · длинное название площадки`,
        url: `https://source-${index}.example.test/monitoring`,
      });
    }
  }
  const settings: Settings = {
    revision: 4,
    board_enabled: true,
    board_anonymous: false,
    board_title: "Состояние сервисов PL",
    board_resource_ids: ["resource-one"],
    timezone: "Europe/Moscow",
    stale_after_seconds: 180,
  };
  const dictionaries: Dictionaries = {
    revision: 2,
    directions: ["Мониторинг", "Сети"],
    sites: ["Москва", "Санкт-Петербург"],
    environments: ["Prod", "Test"],
    types: ["Сервер", "Приложение"],
  };
  const history: HistoryEntry[] = [
    {
      id: "history-general",
      kind: "settings",
      object_id: "global",
      object_name: "Общие параметры",
      action: "updated",
      actor: "other-admin",
      actor_name: "Алексей Администратор",
      created_at: "2026-10-26T08:30:00Z",
      revision: 4,
      detailed: true,
      changes: [
        {
          field: "stale_after_seconds",
          label: "Порог устаревания, с",
          before: 120,
          after: 180,
        },
      ],
    },
    {
      id: "history-integration",
      kind: "integration",
      object_id: "prometheus-main",
      object_name: "Основной Prometheus",
      action: "updated",
      actor: "other-admin",
      actor_name: "Алексей Администратор",
      created_at: "2026-10-26T08:00:00Z",
      revision: 3,
      detailed: true,
      changes: [
        {
          field: "poll_seconds",
          label: "Интервал опроса, с",
          before: 30,
          after: 60,
        },
      ],
    },
  ];
  const failures = new Map<string, { status: number; message: string }>();
  const requests: WorkspaceRequest[] = [];
  const state = {
    integrations,
    settings,
    dictionaries,
    history,
    requests,
    probeStatus: "unreachable",
    probeMessage: "Не удалось подключиться к источнику",
    failNext(path: string, status: number, message: string) {
      failures.set(path, { status, message });
    },
    changeGeneral(values: Partial<Settings>) {
      Object.assign(settings, values, { revision: settings.revision + 1 });
    },
  };

  function conflict(route: Route) {
    return route.fulfill({
      status: 409,
      json: {
        error: "revision_conflict",
        message: "Запись изменилась. Обновите данные и повторите сохранение.",
      },
    });
  }

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    const body = request.postData()
      ? (request.postDataJSON() as Record<string, unknown>)
      : undefined;
    requests.push({ method, path, body });
    const failure = failures.get(path);
    if (failure && method !== "GET") {
      failures.delete(path);
      return route.fulfill({
        status: failure.status,
        json: {
          error:
            failure.status === 409 ? "revision_conflict" : "invalid_settings",
          message: failure.message,
        },
      });
    }
    if (path === "/session") {
      return route.fulfill({
        json: {
          authenticated: true,
          features: { sftp_exchange: true },
          user: {
            id: "settings-admin",
            name: "Администратор Платформы",
            admin: true,
          },
          csrf_token: "settings-test",
          demo: false,
          board_enabled: settings.board_enabled,
          board_anonymous_enabled: settings.board_anonymous,
          timezone: settings.timezone,
        },
      });
    }
    if (path === "/integrations") return route.fulfill({ json: integrations });
    if (/^\/integrations\/[^/]+\/prometheus\/options$/.test(path))
      return route.fulfill({
        json: {
          jobs: ["linux", "windows"],
          labels: ["instance", "job", "site"],
          values: ["Москва"],
          target_count: 12,
          truncated: false,
          observed_at: timestamp,
        },
      });
    if (path === "/settings") return route.fulfill({ json: settings });
    if (path === "/dictionaries") return route.fulfill({ json: dictionaries });
    if (path === "/settings-workspace/probe") {
      return route.fulfill({
        json: {
          status: state.probeStatus,
          message: state.probeMessage,
          checked_at: timestamp,
          duration_ms: 42,
        },
      });
    }
    if (path === "/settings-workspace/general" && method === "PUT") {
      if (body?.revision !== settings.revision) return conflict(route);
      Object.assign(settings, {
        timezone: body.timezone,
        stale_after_seconds: body.stale_after_seconds,
        revision: settings.revision + 1,
      });
      return route.fulfill({ json: settings });
    }
    if (path === "/settings-workspace/publication" && method === "PUT") {
      if (body?.revision !== settings.revision) return conflict(route);
      Object.assign(settings, {
        board_enabled: body.board_enabled,
        board_anonymous: body.board_anonymous,
        board_title: body.board_title,
        board_resource_ids: body.board_resource_ids,
        revision: settings.revision + 1,
      });
      return route.fulfill({ json: settings });
    }
    if (path === "/settings-workspace/dictionaries" && method === "PUT") {
      if (body?.revision !== dictionaries.revision) return conflict(route);
      Object.assign(dictionaries, body, {
        revision: dictionaries.revision + 1,
      });
      return route.fulfill({ json: dictionaries });
    }
    if (path.startsWith("/settings-workspace/integrations")) {
      const id = path.split("/")[3];
      const index = integrations.findIndex((item) => item.id === id);
      if (method === "DELETE") {
        if (
          index < 0 ||
          request.headers()["if-match"] !== String(integrations[index].revision)
        )
          return conflict(route);
        integrations.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
      if (method === "PUT" || method === "POST") {
        if (
          method === "PUT" &&
          (index < 0 || body?.revision !== integrations[index].revision)
        )
          return conflict(route);
        const saved = {
          ...(body as Integration),
          id: id || "integration-new",
          revision: index < 0 ? 1 : integrations[index].revision + 1,
        };
        if (index < 0) integrations.push(saved);
        else integrations[index] = saved;
        return route.fulfill({
          status: method === "POST" ? 201 : 200,
          json: saved,
        });
      }
      return route.fulfill({ json: integrations[index] });
    }
    if (path === "/settings-workspace/history") {
      const kind = url.searchParams.get("kind");
      const id = url.searchParams.get("id");
      return route.fulfill({
        json: {
          items: history.filter(
            (entry) => entry.kind === kind && entry.object_id === id,
          ),
          next_cursor: "",
        },
      });
    }
    const data: Record<string, unknown> = {
      "/time": { server_time: timestamp },
      "/preferences": {
        revision: 1,
        favorites: [],
        hidden_sections: [],
        section_order: [],
        wayline_cards: [],
      },
      "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
      "/workspace-preferences": { revision: 0, system_ids: [], groups: [] },
      "/chart-settings": { revision: 0, charts: [] },
      "/help-state": { disabled: true, seen: [] },
      "/resources": [
        {
          id: "resource-one",
          name: "Сервис мониторинга",
          type: "Приложение",
          lifecycle: "active",
          directions: [],
          sites: [],
          tags: [],
          endpoints: [],
          operations: [],
          check: {},
        },
        {
          id: "resource-two",
          name: "Каталог оборудования",
          type: "Приложение",
          lifecycle: "active",
          directions: [],
          sites: [],
          tags: [],
          endpoints: [],
          operations: [],
          check: {},
        },
      ],
      "/runtime": {
        demo: false,
        oidc_configured: false,
        allowed_cidrs: ["192.0.2.0/24"],
        allowed_ports: [443],
        executor_configured: false,
        probe_origin: "portal backend",
        auth_group_claim: "groups",
        auth_allowed_group: "PlatformAdmins",
      },
    };
    return route.fulfill({ json: data[path] ?? [] });
  });
  return state;
}
