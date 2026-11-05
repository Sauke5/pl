export type Path = "relay" | "final185" | "final2";
export type Mode = "auto" | Path;
type EventFields = {
  at: string;
  actor: string;
  actor_name?: string;
  reason: string;
};
export type Switch = EventFields & { from: Path | null; to: Path | null };
export type ModeEvent = EventFields & {
  event: "mode";
  mode: Mode;
  revision: number;
};
export type HistoryRow = EventFields & {
  path?: Switch;
  mode?: Mode;
  revision?: number;
};

export function historyActor(event: EventFields): string {
  if (event.actor_name?.trim()) return event.actor_name.trim();
  if (event.actor === "automatic") return "Автоматика";
  if (event.actor === "release-check") return "Проверка выпуска";
  if (event.actor === "proxy-root-acceptance") return "Проверка системы";
  if (event.actor.startsWith("ad:")) return "Пользователь AD";
  if (event.actor.startsWith("oidc:")) return "Пользователь SSO";
  return event.actor || "Неизвестно";
}

export function historyRows(
  events: readonly (Switch | ModeEvent)[],
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if ("event" in event) {
      rows.push({ ...event });
      continue;
    }
    const next = events[index + 1];
    const elapsed = next ? Date.parse(next.at) - Date.parse(event.at) : NaN;
    // The controller appends a switch then its mode event under one lock.
    // Legacy events have no operation ID: group only an adjacent matching pair.
    if (
      next &&
      "event" in next &&
      event.actor !== "automatic" &&
      next.actor === event.actor &&
      next.reason === event.reason &&
      (next.mode === "auto" || next.mode === event.to) &&
      elapsed >= 0 &&
      elapsed <= 1000
    ) {
      rows.push({ ...next, path: event });
      index++;
    } else {
      rows.push({ ...event, path: event });
    }
  }
  return rows.reverse().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
