import type { Integration, Settings, Dictionaries } from "../types";

export type SettingsSection =
  | "overview"
  | "integrations"
  | "dictionaries"
  | "publication"
  | "general"
  | "system"
  | "operations"
  | "security"
  | "updates"
  | "installation"
  | "delivery"
  | "users"
  | "ad";
export const sections: {
  id: SettingsSection;
  label: string;
  description: string;
  group?: string;
}[] = [
  {
    id: "overview",
    label: "Обзор",
    description: "Текущая конфигурация Платформы",
  },
  {
    id: "general",
    label: "Время и данные",
    description: "Часовой пояс и срок актуальности показателей",
    group: "Каталог и данные",
  },
  {
    id: "integrations",
    label: "Подключения",
    description: "Источники данных, доступ к ним и частота обновления",
    group: "Каталог и данные",
  },
  {
    id: "dictionaries",
    label: "Справочники",
    description: "Значения для карточек и фильтров каталога",
    group: "Каталог и данные",
  },
  {
    id: "publication",
    label: "Страница для пользователей",
    description: "Какие сервисы показывать пользователям и кому они доступны",
    group: "Каталог и данные",
  },
  {
    id: "users",
    label: "Локальные пользователи",
    description: "Учётные записи в PL и их роли",
    group: "Пользователи и доступ",
  },
  {
    id: "ad",
    label: "Вход через домен",
    description: "Подключение Active Directory и права доменных пользователей",
    group: "Пользователи и доступ",
  },
  {
    id: "security",
    label: "Пароли и сессии",
    description: "Длина локальных паролей и срок действия входа",
    group: "Пользователи и доступ",
  },
  {
    id: "updates",
    label: "Обновления",
    description: "Версия PL, изменения в релизе и установка обновлений",
    group: "Обслуживание",
  },
  {
    id: "delivery",
    label: "Прокси для загрузок",
    description: "Доступ к GitHub для обновлений и установки модулей",
    group: "Обслуживание",
  },
  {
    id: "operations",
    label: "Состояние сервера",
    description: "Память, диск, нагрузка и диагностика PL",
    group: "Обслуживание",
  },
  {
    id: "installation",
    label: "Адрес и сеть",
    description: "Адрес PL, HTTPS-сертификат и доступные для проверок сети",
    group: "Обслуживание",
  },
  {
    id: "system",
    label: "Серверная конфигурация",
    description: "Технические параметры действующей установки",
    group: "Обслуживание",
  },
];
export type SettingsLocation = {
  section: SettingsSection;
  integration?: string;
  field?: string;
};
export function settingsLocation(hash = location.hash): SettingsLocation {
  const query = new URLSearchParams(hash.split("?")[1] || "");
  const section = query.get("section") || "overview";
  return {
    section: sections.some((s) => s.id === section)
      ? (section as SettingsSection)
      : "overview",
    integration: query.get("integration") || undefined,
    field: query.get("field") || undefined,
  };
}
export function settingsHash(value: SettingsLocation) {
  const query = new URLSearchParams({ section: value.section });
  if (value.integration) query.set("integration", value.integration);
  if (value.field) query.set("field", value.field);
  return "#settings?" + query.toString();
}
export type SearchEntry = SettingsLocation & {
  title: string;
  description: string;
  keywords?: string;
};
export const fieldKeywords: Record<string, string> = {
  url: "URL ссылка адрес endpoint",
  poll_seconds: "опрос период частота интервал обновление",
  timeout_seconds: "таймаут timeout ожидание ответа",
  concurrency: "параллелизм параллельно запросы",
  secret_ref: "секрет пароль ключ token credentials",
};
export const searchEntries: SearchEntry[] = [
  {
    section: "delivery",
    title: "Прокси для загрузок",
    description: "Прокси, Xray и проверка загрузки обновлений",
    keywords:
      "HTTP CONNECT SOCKS5 прокси proxy github модули релиз обновления CA",
  },
  {
    section: "installation",
    title: "Адрес и сеть",
    description: "Адрес, интерфейс, TLS-сертификат и сети интеграций",
    keywords: "домен URL HTTPS сертификат CA сеть CIDR порты",
  },
  {
    section: "ad",
    title: "Вход через домен · Active Directory",
    description: "Сервер, домен, группа администраторов и проверка подключения",
    keywords: "AD LDAP LDAPS StartTLS TLS сертификат авторизация вход домен",
  },
  {
    section: "operations",
    title: "Состояние сервера",
    description: "Память, диск, нагрузка и время работы сервера PL",
    keywords: "CPU RAM диск сервер хост диагностика эксплуатация",
  },
  {
    section: "security",
    field: "session_lifetime_minutes",
    title: "Срок действия входа",
    description: "Пароли и сессии · когда потребуется войти снова",
    keywords: "безопасность доступ срок сессия минуты пароль",
  },
  {
    section: "security",
    field: "local_password_min_length",
    title: "Минимальная длина пароля",
    description: "Пароли и сессии · требования к локальным учётным записям",
    keywords: "безопасность символы длина пароль локальный",
  },
  {
    section: "updates",
    title: "Обновления PL",
    description: "Текущая версия, новые возможности и установка релиза",
    keywords: "версия релиз release update эксплуатация",
  },
  {
    section: "users",
    title: "Локальные пользователи",
    description: "Создание и изменение локальных учётных записей",
    keywords: "администратор роль пароль",
  },
  {
    section: "integrations",
    title: "Подключения и интеграции",
    description: "Источники, адреса, состояние, опрос",
    keywords:
      "prometheus alertmanager grafana netbox wayline docker oxidized gitea отчёты",
  },
  {
    section: "dictionaries",
    field: "directions",
    title: "Направления",
    description: "Справочники · разделы каталога",
  },
  {
    section: "dictionaries",
    field: "sites",
    title: "Площадки",
    description: "Справочники · размещение ресурсов",
  },
  {
    section: "dictionaries",
    field: "environments",
    title: "Среды",
    description: "Справочники · Prod, Test, Lab",
  },
  {
    section: "dictionaries",
    field: "types",
    title: "Типы ресурсов",
    description: "Справочники · классификация",
  },
  {
    section: "dictionaries",
    field: "relation_types",
    title: "Типы связей",
    description: "Справочники · связи между ресурсами",
  },
  {
    section: "publication",
    field: "board_enabled",
    title: "Публикация Board",
    description: "Включение и доступ к ресурсам",
  },
  {
    section: "publication",
    field: "board_anonymous",
    title: "Анонимный доступ",
    description: "Публикация · открытие Board без входа",
  },
  {
    section: "publication",
    field: "board_title",
    title: "Заголовок Board",
    description: "Публикация · название страницы",
  },
  {
    section: "publication",
    field: "board_resource_ids",
    title: "Публикуемые ресурсы",
    description: "Публикация · выбор карточек",
  },
  {
    section: "general",
    field: "timezone",
    title: "Часовой пояс",
    description: "Время и данные · даты событий и отчётов",
    keywords: "время дата москва timezone",
  },
  {
    section: "general",
    field: "stale_after_seconds",
    title: "Когда считать данные устаревшими",
    description: "Время и данные · актуальность показателей мониторинга",
    keywords: "порог устаревания секунды stale",
  },
  {
    section: "system",
    field: "auth",
    title: "Вход и доступ",
    description: "Система · способ входа и группа доступа",
    keywords: "ad oidc авторизация",
  },
  {
    section: "system",
    field: "network",
    title: "Сетевые ограничения",
    description: "Система · разрешённые сети и порты",
    keywords: "cidr allowlist",
  },
  {
    section: "system",
    field: "executor",
    title: "Исполнитель операций",
    description: "Система · подключение executor",
  },
];
export type ProbeResult = {
  status: string;
  message: string;
  checked_at: string;
  duration_ms: number;
};
export type HistoryChange = {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
};
export type HistoryItem = {
  id: string;
  kind: string;
  object_id: string;
  object_name: string;
  action: string;
  actor: string;
  actor_name?: string;
  created_at: string;
  revision: number;
  detailed: boolean;
  changes: HistoryChange[];
};
export type HistoryPage = { items: HistoryItem[]; next_cursor?: string };
export type HistoryTarget = {
  kind: "integration" | "settings" | "dictionaries";
  id: string;
  group?: "general" | "publication";
};
export const fieldLabels: Record<string, string> = {
  name: "Название",
  kind: "Тип источника",
  url: "Адрес сервиса",
  enabled: "Подключение включено",
  poll_seconds: "Обновлять каждые, с",
  timeout_seconds: "Ожидание ответа, с",
  concurrency: "Одновременные запросы",
  secret_ref: "Сохранённые учётные данные",
  timezone: "Часовой пояс",
  stale_after_seconds: "Данные устаревают через, с",
  board_enabled: "Публикация Board",
  board_anonymous: "Анонимный доступ",
  board_title: "Заголовок Board",
  board_resource_ids: "Публикуемые ресурсы",
  directions: "Направления",
  sites: "Площадки",
  environments: "Среды",
  types: "Типы ресурсов",
  relation_types: "Типы связей",
  "config.public_url": "Адрес для перехода",
  "config.http_host": "HTTP Host",
  "config.basic_username": "Пользователь Basic Auth",
  "config.stale_after_seconds": "Порог устаревания Wayline, с",
  "config.reports_base_url": "Адрес отчётов",
  "config.discovery_enabled": "Обнаружение ресурсов",
  "config.include_job": "Включённые jobs",
  "config.exclude_job": "Исключённые jobs",
  "config.match_label": "Метка отбора",
  "config.match_value": "Значение метки",
  "config.instance_label": "Метка адреса",
  "config.resource_label": "Метка ресурса",
  "config.dashboard_url": "Адрес панели Grafana",
  "config.gitea_repository_url": "Репозиторий Gitea",
  "config.gitea_branch": "Ветка Gitea",
  "config.node_bindings": "Соответствия устройств",
};
export const integrationKinds = [
  "prometheus",
  "alertmanager",
  "grafana",
  "reports",
  "docker",
  "wayline",
  "netbox",
  "oxidized",
  "fileauditor",
];
export const kindLabels: Record<string, string> = {
  prometheus: "Prometheus",
  alertmanager: "Alertmanager",
  grafana: "Grafana",
  reports: "Отчёты",
  docker: "Docker",
  wayline: "Wayline",
  netbox: "NetBox",
  oxidized: "Oxidized / Gitea",
  fileauditor: "File Auditor",
};
export const integrationFields = [
  "name",
  "kind",
  "url",
  "enabled",
  "poll_seconds",
  "timeout_seconds",
  "concurrency",
  "secret_ref",
  "config",
];
export const generalFields = ["timezone", "stale_after_seconds"];
export const publicationFields = [
  "board_enabled",
  "board_anonymous",
  "board_title",
  "board_resource_ids",
];
export const dictionaryFields = [
  "directions",
  "sites",
  "environments",
  "types",
  "relation_types",
];
export function selectFields<T>(value: T, fields: string[]) {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(fields.map((key) => [key, source[key]]));
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, stable(val)]),
    );
  return value;
}
export function same(a: unknown, b: unknown) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
export function blankIntegration(): Integration {
  return {
    id: "",
    revision: 0,
    name: "",
    kind: "prometheus",
    url: "",
    enabled: true,
    poll_seconds: 60,
    timeout_seconds: 10,
    concurrency: 2,
    secret_ref: "",
    config: {},
    status: "unknown",
    error: "",
    capabilities: [],
  };
}
export type FieldErrors = Record<string, string>;
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
const validURL = (value: string) => {
  try {
    const u = new URL(value);
    return (
      byteLength(value) <= 4096 &&
      !/[\r\n\0]/.test(value) &&
      ["http:", "https:"].includes(u.protocol) &&
      !!u.hostname &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
};
export function validateIntegration(value: Integration): FieldErrors {
  const errors: FieldErrors = {};
  if (!value.name.trim()) errors.name = "Укажите название подключения.";
  else if (byteLength(value.name.trim()) > 160)
    errors.name = "Название слишком длинное. Сократите его.";
  if (!integrationKinds.includes(value.kind))
    errors.kind = "Выберите тип источника.";
  if (value.kind !== "docker" && !validURL(value.url))
    errors.url = "Укажите HTTP(S)-адрес без имени пользователя и пароля.";
  for (const [key, min, max] of [
    ["poll_seconds", 10, 86400],
    ["timeout_seconds", 1, 300],
    ["concurrency", 1, 4],
  ] as const) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      errors[key] = "Допустимо целое число от " + min + " до " + max + ".";
  }
  if (
    value.secret_ref &&
    !value.secret_ref.startsWith("env:PORTAL_SECRET_") &&
    !value.secret_ref.startsWith("file:")
  )
    errors.secret_ref = "Укажите ссылку env:PORTAL_SECRET_* или file:имя.";
  if (
    value.kind === "wayline" &&
    !!value.config.basic_username !== !!value.secret_ref
  )
    errors["config.basic_username"] =
      "Укажите пользователя и ссылку на пароль вместе.";
  if (
    value.kind === "wayline" &&
    value.config.basic_username &&
    (byteLength(value.config.basic_username) > 160 ||
      /[:\r\n]/.test(value.config.basic_username))
  )
    errors["config.basic_username"] =
      "Сократите имя пользователя и уберите двоеточие или переносы строк.";
  for (const key of ["public_url", "reports_base_url", "dashboard_url"])
    if (value.config[key] && !validURL(value.config[key]))
      errors["config." + key] = "Укажите корректный HTTP(S)-адрес.";
  for (const [key, entry] of Object.entries(value.config)) {
    if (value.kind === "oxidized" && key === "node_bindings") continue;
    if (value.kind === "netbox" && ["http_host", "public_url"].includes(key))
      continue;
    if (
      value.kind === "wayline" &&
      ["basic_username", "stale_after_seconds", "public_url"].includes(key)
    )
      continue;
    if (byteLength(entry) > 2048)
      errors["config." + key] = "Значение слишком длинное. Сократите его.";
  }
  if (value.kind === "wayline" && value.config.stale_after_seconds) {
    const n = Number(value.config.stale_after_seconds);
    if (!Number.isInteger(n) || n < 30 || n > 86400)
      errors["config.stale_after_seconds"] = "Допустимо от 30 до 86400 секунд.";
  }
  if (value.kind === "oxidized") {
    try {
      const repository = new URL(value.config.gitea_repository_url || "");
      if (
        !validURL(repository.href) ||
        repository.search ||
        repository.hash ||
        !validConfigurationPath(
          repository.pathname.replace(/^\/+|\/+$/g, ""),
        ) ||
        repository.pathname.split("/").filter(Boolean).length < 2
      )
        throw new Error();
    } catch {
      errors["config.gitea_repository_url"] =
        "Укажите адрес репозитория Gitea.";
    }
    if (
      value.config.gitea_branch &&
      (byteLength(value.config.gitea_branch) > 128 ||
        !validConfigurationPath(value.config.gitea_branch))
    )
      errors["config.gitea_branch"] = "Укажите название ветки.";
    try {
      const raw = value.config.node_bindings || "{}";
      const bindings: unknown = JSON.parse(raw);
      if (
        !bindings ||
        typeof bindings !== "object" ||
        Array.isArray(bindings) ||
        byteLength(raw) > 16384 ||
        Object.keys(bindings).length > 100
      )
        throw new Error();
      for (const [key, id] of Object.entries(bindings))
        if (
          !validConfigurationPath(key) ||
          !key.includes("/") ||
          typeof id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            id,
          )
        )
          throw new Error();
    } catch {
      errors["config.node_bindings"] =
        "Проверьте имена устройств и выбранные ресурсы. Не более 100 соответствий.";
    }
  }
  return errors;
}
function validConfigurationPath(value: string) {
  return (
    !!value &&
    byteLength(value) <= 512 &&
    !/[\\\r\n\x00-\x1f\x7f?#]/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
export function validateGeneral(value: Settings): FieldErrors {
  const errors: FieldErrors = {};
  try {
    new Intl.DateTimeFormat("ru", { timeZone: value.timezone }).format();
    if (!value.timezone.trim()) throw new Error();
  } catch {
    errors.timezone =
      "Укажите существующий часовой пояс, например Europe/Moscow.";
  }
  if (
    !Number.isInteger(value.stale_after_seconds) ||
    value.stale_after_seconds < 30 ||
    value.stale_after_seconds > 86400
  )
    errors.stale_after_seconds = "Допустимо целое число от 30 до 86400 секунд.";
  return errors;
}
export function validatePublication(value: Settings): FieldErrors {
  const errors: FieldErrors = {};
  if (byteLength(value.board_title) > 160)
    errors.board_title = "Сократите заголовок Board.";
  if (value.board_anonymous && !value.board_enabled)
    errors.board_anonymous = "Сначала включите публикацию Board.";
  if (value.board_resource_ids.length > 1000)
    errors.board_resource_ids = "Можно выбрать не более 1000 ресурсов.";
  return errors;
}
export function validateDictionaries(value: Dictionaries): FieldErrors {
  return Object.fromEntries(
    dictionaryFields.flatMap((key) => {
      const items = value[key as keyof Omit<Dictionaries, "revision">] ?? [];
      const message =
        items.length > 200
          ? "Не более 200 значений."
          : items.some((item) => !item.trim() || byteLength(item) > 100)
            ? "Укажите непустые значения и сократите слишком длинные."
            : new Set(items.map((item) => item.trim())).size !== items.length
              ? "Удалите повторяющиеся значения."
              : "";
      return message ? [[key, message]] : [];
    }),
  );
}
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (Array.isArray(value))
    return value.length ? value.map(displayValue).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
