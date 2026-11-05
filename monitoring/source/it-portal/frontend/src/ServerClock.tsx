import { useEffect, useState } from "react";
import { api } from "./api";

export function ServerClock({ timezone }: { timezone: string }) {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    let disposed = false;
    let anchor: { server: number; client: number } | undefined;
    let controller: AbortController | undefined;
    const tick = () => {
      const elapsed = anchor ? performance.now() - anchor.client : Infinity;
      setNow(anchor && elapsed < 120000 ? anchor.server + elapsed : undefined);
    };
    const sync = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const start = performance.now();
      const timeout = window.setTimeout(() => current.abort(), 10000);
      try {
        const result = await api<{ server_time: string }>(
          "/time",
          "GET",
          undefined,
          {},
          current.signal,
        );
        const end = performance.now();
        const server = Date.parse(result.server_time);
        if (!disposed && !current.signal.aborted && Number.isFinite(server)) {
          anchor = { server: server + (end - start) / 2, client: end };
          tick();
        }
      } catch {
        /* Keep recent synchronization; never substitute the PC clock. */
      } finally {
        window.clearTimeout(timeout);
      }
    };
    const visible = () => {
      if (!document.hidden) void sync();
    };
    void sync();
    const clock = window.setInterval(tick, 250);
    const refresh = window.setInterval(() => {
      if (!document.hidden) void sync();
    }, 60000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(clock);
      window.clearInterval(refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  if (now === undefined)
    return <p className="home-server-clock muted">Время сервера недоступно</p>;
  const value = new Date(now);
  return (
    <p className="home-server-clock" title={`Время сервера · ${timezone}`}>
      <span>
        {new Intl.DateTimeFormat("ru-RU", {
          weekday: "long",
          day: "numeric",
          month: "long",
          timeZone: timezone,
        }).format(value)}
      </span>
      <time dateTime={value.toISOString()}>
        {new Intl.DateTimeFormat("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
          timeZone: timezone,
        }).format(value)}
      </time>
    </p>
  );
}
