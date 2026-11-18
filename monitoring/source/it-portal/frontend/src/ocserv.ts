export type VPNProfile = { id: string; name: string; networks: string[] };
export type VPNGrant = {
  subject: string;
  display_name: string;
  profile_id: string;
  expires_at: string;
  status: string;
};
export type VPNSession = {
  id: string;
  subject: string;
  ip: string;
  device: string;
  since: string;
};
export type VPNState = {
  revision: number;
  gateway: {
    name: string;
    auth_mode: string;
    ready: boolean;
    pool: string;
    observed_at: string;
    sessions_known: boolean;
  };
  profiles: VPNProfile[];
  grants: VPNGrant[];
  sessions: VPNSession[];
  events: { at: string; actor: string; action: string; subject: string }[];
};
export type VPNDialog =
  | { kind: "profile"; id?: string }
  | { kind: "grant"; subject?: string; profile?: string }
  | { kind: "revoke"; subject: string }
  | { kind: "terminate"; session: VPNSession };
export type VPNTab = "employees" | "networks";
export type VPNPayload = Record<string, string | string[]>;

export const authLabel = (mode: string) =>
  ({ certificate: "Клиентский сертификат", oidc: "Корпоративный OIDC" })[
    mode
  ] || "Не настроен";
export const grantLabels: Record<string, string> = {
  active: "Действует",
  revoked: "Отозван",
  expired: "Истёк",
  pending: "Ожидает применения",
};
export const eventLabels: Record<string, string> = {
  grant: "Назначение доступа",
  profile: "Изменение профиля",
  terminate: "Завершение сессии",
  revoke: "Отзыв доступа",
};
export const isExpiring = (grant: VPNGrant, now: number) => {
  const expiry = Date.parse(grant.expires_at);
  return (
    grant.status === "active" && expiry > now && expiry - now <= 7 * 86400000
  );
};
const format = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
});
export const vpnTimezone = format.resolvedOptions().timeZone;
export function formatTime(stamp?: string) {
  const time = Date.parse(stamp || "");
  return Number.isFinite(time) ? format.format(time) : "Нет данных";
}
export function expiryInput(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "";
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

export type IPV4Range = [number, number];
export function cidrRange(cidr: string): IPV4Range | undefined {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(
    cidr,
  );
  if (!parts) return;
  const octets = parts.slice(1, 5);
  if (
    octets.some(
      (octet) => Number(octet) > 255 || String(Number(octet)) !== octet,
    )
  )
    return;
  const prefix = Number(parts[5]);
  if (prefix < 1 || prefix > 32 || String(prefix) !== parts[5]) return;
  const start = octets.reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const length = 2 ** (32 - prefix);
  if (start % length !== 0) return;
  return [start, start + length - 1];
}

// A row is covered when the union of the sorted profile networks contains it.
export function networkAccess(
  range: IPV4Range | undefined,
  rules: IPV4Range[] | undefined,
) {
  if (!range || !rules) return "unknown";
  let next = range[0];
  let intersects = false;
  for (const [start, end] of rules) {
    if (end < range[0]) continue;
    if (start > range[1]) break;
    if (start > next) return "partial";
    intersects = true;
    next = Math.max(next, end + 1);
    if (next > range[1]) return "allowed";
  }
  return intersects ? "partial" : "closed";
}
