export type TrafficDirection = "downlink" | "uplink";

export type TrafficRoute = {
  tag: string;
  label: string;
  received: number | null;
  sent: number | null;
};

const routeLabels = new Map([
  ["office-ai-http-relay", "Edge · TCP"],
  ["proxy", "Edge · UDP"],
  ["final185", "185"],
  ["final2", "2.26"],
  ["direct", "Прямой выход 4.14"],
]);

const counterPattern = /^outbound>>>([^>]+)>>>traffic>>>(downlink|uplink)$/;

export function trafficRoutes(values: Record<string, number>): TrafficRoute[] {
  const routes: TrafficRoute[] = Array.from(routeLabels, ([tag, label]) => ({
    tag,
    label,
    received: null,
    sent: null,
  }));
  const byTag = new Map(routes.map((route) => [route.tag, route]));

  for (const [name, value] of Object.entries(values)) {
    const match = counterPattern.exec(name);
    if (!match || !Number.isSafeInteger(value) || value < 0) continue;
    const route = byTag.get(match[1]);
    if (!route) continue;
    if ((match[2] as TrafficDirection) === "downlink") route.received = value;
    else route.sent = value;
  }
  return routes;
}

export function formatBytes(value: number | null): string {
  if (value == null) return "Нет данных";
  if (value === 0) return "0 Б";
  const units = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"];
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  const scaled = value / 1024 ** exponent;
  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: scaled < 10 && exponent > 0 ? 1 : 0,
  }).format(scaled)} ${units[exponent]}`;
}

export function establishedTCP(summary: string): number | null {
  for (const line of summary.split(/\r?\n/)) {
    const match = /^TCP:\s+\d+\s+\(\s*estab\s+(\d+)\b/.exec(line.trim());
    if (!match) continue;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
}
