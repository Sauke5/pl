import { Activity, Plus, X } from "lucide-react";
import { date, safeURL, useAPI } from "./api";
import {
  Badge,
  Empty,
  ErrorBox,
  ExternalLink,
  Panel,
} from "./components/common";
import { Button } from "./components/ui/button";
import type { Preferences, WaylineData, WaylineResult } from "./types";

function resultAge(result: WaylineResult) {
  const timestamp = result.finished_at || result.started_at;
  const elapsed = timestamp ? Date.now() - Date.parse(timestamp) : NaN;
  if (!Number.isFinite(elapsed)) return "Время проверки неизвестно";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  return minutes < 1
    ? "Только что"
    : minutes < 60
      ? `${minutes} мин назад`
      : `${Math.floor(minutes / 60)} ч назад`;
}

function Result({
  result,
  speed = false,
}: {
  result: WaylineResult | null;
  speed?: boolean;
}) {
  if (!result)
    return (
      <p className="muted">
        {speed ? "Скорость ещё не измерена" : "Проверок ещё не было"}
      </p>
    );
  const value = (n: number | undefined, unit: string) =>
    n == null || !Number.isFinite(n)
      ? "—"
      : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n)} ${unit}`;
  const labels = {
    success: "Успешно",
    degraded: "Есть потери",
    failed: "Ошибка проверки",
    unknown: "Нет данных",
  };
  return (
    <div className="wayline-result">
      <div className="simple-row">
        <strong>{speed ? "Скорость" : "Доступность"}</strong>
        <Badge
          value={
            result.stale
              ? "stale"
              : result.status === "success"
                ? "healthy"
                : result.status === "degraded"
                  ? "warning"
                  : result.status
          }
        >
          {result.stale ? "Устарело" : labels[result.status]}
        </Badge>
      </div>
      <dl className="detail-grid">
        {speed ? (
          <div>
            <dt>
              {result.direction === "download"
                ? "Скачивание"
                : result.direction === "upload"
                  ? "Отправка"
                  : "Направление неизвестно"}
            </dt>
            <dd>
              {value(
                result.throughput_bps == null
                  ? undefined
                  : result.throughput_bps / 1e6,
                "Мбит/с",
              )}
            </dd>
          </div>
        ) : (
          <>
            <div>
              <dt>Задержка</dt>
              <dd>{value(result.avg_latency_ms, "мс")}</dd>
            </div>
            <div>
              <dt>Потери</dt>
              <dd>{value(result.loss_percent, "%")}</dd>
            </div>
          </>
        )}
      </dl>
      {result.error_message && (
        <p className="text-danger break">{result.error_message}</p>
      )}
      <small
        className="muted"
        title={date(result.finished_at || result.started_at)}
      >
        {resultAge(result)} · {date(result.finished_at || result.started_at)}
      </small>
    </div>
  );
}

export function WaylineDashboard({
  preferences,
  onChange,
  onSelect,
}: {
  preferences?: Preferences;
  onChange: (value: Preferences) => void;
  onSelect: () => void;
}) {
  const data = useAPI<WaylineData>("/wayline");
  const cards = preferences?.wayline_cards || [];
  if (preferences?.hidden_sections.includes("wayline")) return null;
  return (
    <Panel
      className="wayline-panel"
      title="Проверки Wayline"
      icon={<Activity size={20} />}
      action={
        <Button size="sm" onClick={onSelect}>
          <Plus size={15} />
          Добавить карточки
        </Button>
      }
    >
      {data.error && (
        <ErrorBox error={data.error} retry={() => void data.refetch()} />
      )}
      {!cards.length ? (
        <Empty
          title="Выберите проверки для главной"
          detail="Карточки показывают последние результаты доступности и скорости из Wayline."
        />
      ) : (
        <div className="wayline-grid">
          {cards.map((card) => {
            const source = data.data?.sources.find(
              (s) => s.integration_id === card.integration_id,
            );
            const target = source?.targets.find((t) => t.id === card.target_id);
            const href = source?.url && safeURL(source.url);
            const link = href ? new URL(href) : undefined;
            if (link) {
              link.hash = `availability?target=${card.target_id}`;
            }
            const unavailable = !!data.error || source?.status !== "ok";
            return (
              <article
                className="wayline-card"
                key={`${card.integration_id}:${card.target_id}`}
              >
                <div className="simple-row">
                  <div className="wayline-card-title">
                    <h3>{target?.name || `Цель #${card.target_id}`}</h3>
                    <small className="muted break">
                      {target?.host || source?.name || "Источник Wayline"}
                    </small>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Убрать карточку ${target?.name || card.target_id}`}
                    onClick={() =>
                      preferences &&
                      onChange({
                        ...preferences,
                        wayline_cards: cards.filter(
                          (c) =>
                            c.integration_id !== card.integration_id ||
                            c.target_id !== card.target_id,
                        ),
                      })
                    }
                  >
                    <X size={16} />
                  </Button>
                </div>
                {data.isPending ? (
                  <p className="muted">Загрузка результатов…</p>
                ) : unavailable ? (
                  <p className="error-box">
                    {source?.status === "disabled"
                      ? "Источник отключён"
                      : source?.error ||
                        "Источник недоступен. Актуальность результатов не подтверждена."}
                  </p>
                ) : !target ? (
                  <p className="muted">
                    Цель удалена или недоступна в источнике.
                  </p>
                ) : (
                  <>
                    {!target.enabled && (
                      <Badge value="disabled">Автопроверка отключена</Badge>
                    )}
                    <Result result={target.path} />
                    {(target.iperf_enabled || target.iperf) && (
                      <Result result={target.iperf} speed />
                    )}
                  </>
                )}
                <div className="wayline-card-footer">
                  <small className="muted">{source?.name || "Wayline"}</small>
                  {link && (
                    <ExternalLink url={link.href}>
                      Открыть в Wayline
                    </ExternalLink>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function WaylineSelection({
  value,
  onChange,
}: {
  value: Preferences;
  onChange: (value: Preferences) => void;
}) {
  const data = useAPI<WaylineData>("/wayline");
  const cards = value.wayline_cards || [];
  return (
    <div className="form-section">
      <h3>Карточки Wayline</h3>
      <p className="muted">
        Выберите цели. Последние результаты появятся на главной странице.
      </p>
      {data.error ? (
        <ErrorBox error={data.error} retry={() => void data.refetch()} />
      ) : data.isPending ? (
        <p className="muted">Загрузка целей…</p>
      ) : !data.data?.sources.length ? (
        <p className="muted">
          Сначала подключите Wayline в разделе «Настройки → Интеграции».
        </p>
      ) : (
        data.data.sources.map((source) => (
          <div key={source.integration_id}>
            <h4>{source.name}</h4>
            {source.status !== "ok" ? (
              <p className="error-box">
                {source.status === "disabled"
                  ? "Источник отключён"
                  : source.error || "Источник недоступен"}
              </p>
            ) : !source.targets.length ? (
              <p className="muted">В источнике пока нет целей.</p>
            ) : (
              source.targets.map((target) => (
                <label className="checkbox-label" key={target.id}>
                  <input
                    type="checkbox"
                    checked={cards.some(
                      (c) =>
                        c.integration_id === source.integration_id &&
                        c.target_id === target.id,
                    )}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        wayline_cards: e.target.checked
                          ? [
                              ...cards,
                              {
                                integration_id: source.integration_id,
                                target_id: target.id,
                              },
                            ]
                          : cards.filter(
                              (c) =>
                                c.integration_id !== source.integration_id ||
                                c.target_id !== target.id,
                            ),
                      })
                    }
                  />
                  <span>
                    {target.name} <small className="muted">{target.host}</small>
                  </span>
                </label>
              ))
            )}
          </div>
        ))
      )}
      {cards
        .filter(
          (card) =>
            !data.data?.sources.some(
              (source) =>
                source.integration_id === card.integration_id &&
                source.targets.some((target) => target.id === card.target_id),
            ),
        )
        .map((card) => (
          <div
            className="simple-row"
            key={`${card.integration_id}:${card.target_id}`}
          >
            <span>Цель #{card.target_id} · недоступна в источнике</span>
            <Button
              size="sm"
              onClick={() =>
                onChange({
                  ...value,
                  wayline_cards: cards.filter((c) => c !== card),
                })
              }
            >
              Убрать
            </Button>
          </div>
        ))}
    </div>
  );
}
