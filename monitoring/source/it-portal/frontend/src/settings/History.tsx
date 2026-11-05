import { useCallback, useEffect, useRef, useState } from "react";
import { History as HistoryIcon, RefreshCw, X } from "lucide-react";
import { api, date } from "../api";
import { Button } from "../components/ui/button";
import { Empty, ErrorBox } from "../components/common";
import { displayValue, type HistoryPage, type HistoryTarget } from "./model";

type HistoryState = {
  path: string;
  pages: HistoryPage[];
  busy: boolean;
  loading: boolean;
  error?: unknown;
  failed?: "first" | "more";
};

export function SettingsHistory({
  target,
  onClose,
}: {
  target: HistoryTarget;
  onClose: () => void;
}) {
  const query = new URLSearchParams({
    kind: target.kind,
    id: target.id,
    limit: "30",
  });
  if (target.group) query.set("group", target.group);
  const path = "/settings-workspace/history?" + query.toString();
  const [state, setState] = useState<HistoryState>({
    path,
    pages: [],
    busy: true,
    loading: true,
  });
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const current: HistoryState =
    state.path === path
      ? state
      : { path, pages: [], busy: true, loading: true };
  const all = current.pages.flatMap((page) => page.items);
  const unique = all.filter(
    (item, index) => all.findIndex((other) => other.id === item.id) === index,
  );
  const cursor = current.pages[current.pages.length - 1]?.next_cursor;

  const loadFirst = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    const token = ++generation.current;
    request.current = controller;
    setState((previous) =>
      previous.path === path
        ? {
            ...previous,
            busy: true,
            loading: !previous.pages.length,
            error: undefined,
            failed: undefined,
          }
        : { path, pages: [], busy: true, loading: true },
    );
    try {
      const page = await api<HistoryPage>(
        path,
        "GET",
        undefined,
        {},
        controller.signal,
      );
      if (token === generation.current)
        setState({ path, pages: [page], busy: false, loading: false });
    } catch (cause) {
      if (token === generation.current && !controller.signal.aborted)
        setState((previous) => ({
          ...previous,
          busy: false,
          loading: false,
          error: cause,
          failed: "first",
        }));
    } finally {
      if (token === generation.current) request.current = undefined;
    }
  }, [path]);

  useEffect(() => {
    void loadFirst();
    return () => {
      ++generation.current;
      request.current?.abort();
      request.current = undefined;
    };
  }, [loadFirst]);

  async function more() {
    if (!cursor || current.busy || request.current) return;
    const controller = new AbortController();
    const token = ++generation.current;
    request.current = controller;
    setState((previous) => ({
      ...previous,
      busy: true,
      error: undefined,
      failed: undefined,
    }));
    try {
      const page = await api<HistoryPage>(
        path + "&cursor=" + encodeURIComponent(cursor),
        "GET",
        undefined,
        {},
        controller.signal,
      );
      if (token === generation.current)
        setState((previous) => ({
          ...previous,
          pages: [...previous.pages, page],
          busy: false,
        }));
    } catch (cause) {
      if (token === generation.current && !controller.signal.aborted)
        setState((previous) => ({
          ...previous,
          busy: false,
          error: cause,
          failed: "more",
        }));
    } finally {
      if (token === generation.current) request.current = undefined;
    }
  }
  return (
    <section
      className="settings-history"
      aria-label="История изменений"
      aria-busy={current.busy}
    >
      <div className="settings-heading">
        <h3>
          <HistoryIcon size={18} />
          История изменений
        </h3>
        <div className="actions">
          <Button
            size="sm"
            onClick={() => void loadFirst()}
            disabled={current.busy}
          >
            <RefreshCw size={15} />
            Обновить историю
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Закрыть историю"
          >
            <X size={18} />
          </Button>
        </div>
      </div>
      {current.loading ? (
        <p role="status">Загрузка истории…</p>
      ) : !unique.length && !current.error ? (
        <Empty title="Изменений пока нет" />
      ) : (
        <ol className="settings-timeline">
          {unique.map((item) => (
            <li key={item.id}>
              <div className="settings-history-meta">
                <strong>
                  {item.actor_name ||
                    (item.actor === "system" ? "Платформа" : item.actor) ||
                    "Автор не указан"}
                </strong>
                <time dateTime={item.created_at}>{date(item.created_at)}</time>
              </div>
              <p>
                {item.action === "created"
                  ? "Создано подключение"
                  : item.action === "deleted"
                    ? "Удалено подключение"
                    : "Изменены параметры"}
                {item.revision > 0 && (
                  <span className="muted"> · версия {item.revision}</span>
                )}
              </p>
              {item.detailed && item.changes?.length ? (
                <div className="settings-table-scroll">
                  <table className="settings-history-table">
                    <thead>
                      <tr>
                        <th>Параметр</th>
                        <th>Было</th>
                        <th>Стало</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.changes.map((change) => (
                        <tr key={change.field}>
                          <th scope="row">{change.label || change.field}</th>
                          <td>{displayValue(change.before)}</td>
                          <td>{displayValue(change.after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">
                  {item.detailed
                    ? "Параметры не изменились."
                    : "В этой записи сохранены автор, время и факт изменения."}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {!!current.error && (
        <ErrorBox
          error={current.error}
          retry={() => void (current.failed === "more" ? more() : loadFirst())}
        />
      )}
      {cursor && (
        <Button onClick={() => void more()} disabled={current.busy}>
          {current.busy ? "Загрузка…" : "Показать ещё"}
        </Button>
      )}
    </section>
  );
}
