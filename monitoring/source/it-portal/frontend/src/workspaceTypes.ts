import type { Job, PortalEvent, Problem, Resource } from "./types";

export type SystemMetricBinding = {
  id: string;
  metric: string;
  title: string;
  integration_id: string;
  labels: Record<string, string>;
  resource_id?: string;
};
export type SystemDefinition = {
  id: string;
  revision: number;
  name: string;
  description: string;
  profile: string;
  planned: boolean;
  resource_ids: string[];
  metrics: SystemMetricBinding[];
};
export type FavoriteGroup = {
  id: string;
  name: string;
  resource_ids: string[];
  collapsed: boolean;
};
export type WorkspacePreferences = {
  revision: number;
  system_ids: string[];
  groups: FavoriteGroup[];
};
export type SystemProfiles = {
  profiles: {
    key: string;
    title: string;
    description: string;
    metrics: string[];
  }[];
  metrics: {
    key: string;
    title: string;
    description: string;
    unit: string;
    profiles: string[];
  }[];
};
export type SystemMetricResult = {
  resource_id?: string;
  id: string;
  metric: string;
  title: string;
  unit: string;
  state: string;
  source: string;
  error?: string;
  samples: {
    labels: Record<string, string>;
    value: number;
    observed_at: string;
  }[];
};
export type WorkspaceOperation = Job & { actor_name: string };
export type SystemSnapshot = {
  coverage: { resource_id: string; state: string }[];
  system: SystemDefinition;
  state: string;
  observed_at: string;
  resources: Resource[];
  missing_resource_ids: string[];
  metrics: SystemMetricResult[];
  problems: Problem[];
  events: PortalEvent[];
  operations: WorkspaceOperation[];
};
export type MarketingTarget = { integration_id: string; instance: string };
export type ProblemPresentation = {
  revision: number;
  resource_ids: string[];
  targets: MarketingTarget[];
};
export type PresentedProblem = Problem & { marketing: boolean };

export const workspaceStateLabels: Record<string, string> = {
  definition: "Состав и показатели системы",
  planned: "Запланировано",
  no_data: "Нет данных",
  unconfigured: "Источник не подключён",
  unsupported: "Показатель не поддерживается",
  error: "Ошибка источника",
  fresh: "Свежие данные",
  stale: "Данные устарели",
  observed: "Данные обновлены",
  attention: "Требует внимания",
  incomplete: "Состав требует проверки",
};
