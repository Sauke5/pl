import iconChoices from "../../internal/model/resource-icons.json" with { type: "json" };

/** Product identities only: never embed catalog IDs, private hosts or management paths. */
export const systemIconRules = [
  {
    key: "doska",
    match: /(?:^|[^\p{L}\p{N}])(?:doska|доска)(?=$|[^\p{L}\p{N}])/u,
    tone: "blue",
  },
  {
    key: "forms",
    match: /(?:^|[^\p{L}\p{N}])(?:forms|heyform|опросы)(?=$|[^\p{L}\p{N}])/u,
    tone: "purple",
  },
  { key: "prometheus", match: /\bprometheus\b/, tone: "orange" },
  { key: "alertmanager", match: /\balertmanager\b/, tone: "orange" },
  { key: "grafana", match: /\bgrafana\b/, tone: "orange" },
  { key: "gitea", match: /\bgitea\b/, tone: "green" },
  { key: "netbox", match: /\bnetbox\b/, tone: "green" },
  { key: "oxidized", match: /\boxidized\b/, tone: "purple" },
  { key: "dozzle", match: /\bdozzle\b/, tone: "cyan" },
  { key: "dns", match: /\badguard\b|\bedge\s*dns\b/, tone: "green" },
  { key: "esxi", match: /\besxi\b|\bvmware\b/, tone: "cyan" },
  { key: "idrac", match: /\bidrac\b/, tone: "cyan" },
  {
    key: "bmc",
    match: /\bbmc\b|\bsupermicro\b|\bmegarac\b/,
    tone: "cyan",
  },
  {
    key: "cloud",
    match: /\bmt[cs][\s-]*cloud\b|мтс\s*cloud|мтс\s*облак/,
    tone: "cyan",
  },
  { key: "netronome", match: /\bnetronome\b/, tone: "cyan" },
  { key: "academy", match: /\bacademy\b|академ/, tone: "purple" },
  { key: "rds", match: /\brds\b|\brdweb\b|терминальн/, tone: "blue" },
  {
    key: "support",
    match: /\bservice\s*desk\b|\bitilium\b|технич\S* поддерж|сервис\S* поддерж/,
    tone: "green",
  },
  { key: "wayline", match: /\bwayline\b/, tone: "cyan" },
  { key: "wiki", match: /\bwiki\b|база знаний/, tone: "purple" },
  { key: "sftp", match: /\bsftp\b/, tone: "purple" },
  {
    key: "topology",
    match:
      /\bnetmap\b|\btopology\b|карта\s+(сети|инфраструктуры|филиалов)|тополог/,
    tone: "cyan",
  },
  { key: "docker", match: /\bdocker\b|контейнер/, tone: "blue" },
  { key: "reports", match: /\breports?\b|отч[её]т/, tone: "blue" },
  {
    key: "monitoringAdmin",
    match:
      /\bmonitoring[\s-]*admin\b|управление мониторинг|администрирование мониторинг/,
    tone: "orange",
  },
  {
    key: "websitesAdmin",
    match: /\bwebsites[\s-]*admin\b|управление сайт|администрирование сайт/,
    tone: "blue",
  },
  {
    key: "auditor",
    match:
      /\bfile[\s-]*(structure[\s-]*)?auditor\b|файлов\S*\s+аудитор|аудит\S*\s+файл/,
    tone: "purple",
  },
  { key: "vega", match: /\bvega\b|1[фсc]|вега/, tone: "blue" },
  { key: "proxyEdge", match: /\bproxy[\s-]*edge\b/, tone: "green" },
  {
    key: "proxy",
    match: /\b3x[\s-]*ui\b|\bxray\b|\bproxy\b|прокси/,
    tone: "green",
  },
] as const;
export type SystemIconKey =
  | (typeof systemIconRules)[number]["key"]
  | "server"
  | "network"
  | "database"
  | "folder"
  | "security"
  | "monitoring"
  | "app"
  | "web";
export type ResourceIconChoice = SystemIconKey | "auto";
export const resourceIconChoices = iconChoices as {
  key: SystemIconKey;
  label: string;
}[];

export type IconTone = "blue" | "cyan" | "purple" | "green" | "orange";
export type IconIdentity = {
  name?: string;
  type?: string;
  url?: string;
  icon?: string;
  manualIcon?: string;
};

function normalized(value = "") {
  return value.normalize("NFKC").toLocaleLowerCase("ru").replace(/[_·]/g, " ");
}
function publicURLIdentity(value = "") {
  try {
    const url = new URL(value, "https://portal.invalid");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      return "";
    // Never use query, fragment or credentials for identity. Routes are inspected
    // locally; no request, remote image or catalog identifier is involved.
    return normalized(`${url.hostname} ${decodeURIComponent(url.pathname)}`);
  } catch {
    return "";
  }
}
export function resolveResourceIcon({
  name,
  type,
  url,
  icon,
  manualIcon,
}: IconIdentity = {}): { key: SystemIconKey; tone: IconTone } {
  if (
    manualIcon &&
    manualIcon !== "auto" &&
    resourceIconChoices.some((choice) => choice.key === manualIcon)
  ) {
    const rule = systemIconRules.find((rule) => rule.key === manualIcon);
    return { key: manualIcon as SystemIconKey, tone: rule?.tone || "blue" };
  }
  // Legacy employee choices remain intentional overrides in automatic mode.
  if (icon === "book") return { key: "wiki", tone: "purple" };
  if (icon === "folder") return { key: "folder", tone: "purple" };
  if (icon === "support") return { key: "support", tone: "green" };
  const appIdentity =
    !type ||
    /^(?:web(?:-сервис)?|app|application|приложение|сервис)$/u.test(
      normalized(type),
    );
  for (const identity of [normalized(name), publicURLIdentity(url)]) {
    const rule = systemIconRules.find(
      (rule) =>
        (appIdentity || (rule.key !== "doska" && rule.key !== "forms")) &&
        rule.match.test(identity),
    );
    if (rule) return { key: rule.key, tone: rule.tone };
  }
  const text = normalized(`${type || ""} ${name || ""}`);
  if (/^management$|управление оборудован/.test(normalized(type)))
    return { key: "bmc", tone: "cyan" };
  if (/database|баз.*данн/.test(text))
    return { key: "database", tone: "purple" };
  if (/file|файл|storage|хранилищ/.test(text))
    return { key: "folder", tone: "purple" };
  if (/container|контейн/.test(text)) return { key: "docker", tone: "blue" };
  if (/network|сетев|коммутатор|маршрутизатор|router|switch|vpn/.test(text))
    return { key: "network", tone: "cyan" };
  if (/виртуальн.*машин|virtual[ -]*machine|\bvm\b/.test(text))
    return { key: "rds", tone: "blue" };
  if (/server|сервер|оборуд|устройство|\bdevice\b/.test(text))
    return { key: "server", tone: "cyan" };
  if (/security|безопас|firewall/.test(text))
    return { key: "security", tone: "green" };
  if (/monitor|монитор|метрик/.test(text))
    return { key: "monitoring", tone: "orange" };
  return { key: icon === "app" ? "app" : "web", tone: "blue" };
}
