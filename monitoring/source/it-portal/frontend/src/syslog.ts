import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type SyslogSource = {
  source: string;
  address: string;
  last_seen: string;
  last_message: string;
  severity: string;
};
export type SyslogMessage = {
  time: string;
  device_time?: string;
  source: string;
  address: string;
  severity: string;
  program?: string;
  format?: string;
  message: string;
};
export type SyslogList<T> = { items: T[]; truncated: boolean };
export type SyslogReceiver = {
  address: string;
  addresses: string[];
  port: number;
  tcp: boolean;
  udp: boolean;
  retention_days: number;
  revision: number;
};
export type SourceIdentity = Pick<SyslogSource, "source" | "address">;

export function useSyslogRead<T>(path: string, enabled = true) {
  return useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api<T>(path, "GET", undefined, {}, signal),
    enabled,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}
export const severityNames = [
  "Авария",
  "Тревога",
  "Критическая ошибка",
  "Ошибка",
  "Предупреждение",
  "Уведомление",
  "Информация",
  "Отладка",
];
export function severityName(value: string) {
  return severityNames[parseSeverity(value)] || value || "Не передан";
}
export function parseSeverity(value: string) {
  return /^[0-7]$/.test(value) ? Number(value) : -1;
}
export const syslogTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const timestampFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: syslogTimezone,
});
export function syslogTime(value?: string) {
  if (!value) return "Не передано";
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? timestampFormat.format(millis) : value;
}
export function sourceKey(item: SourceIdentity) {
  return JSON.stringify([item.source, item.address]);
}
export function sourceName(item: SourceIdentity) {
  return item.source || item.address || "Имя не передано";
}
