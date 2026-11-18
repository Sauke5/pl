import { useState } from "react";
import {
  Activity,
  CalendarClock,
  ChevronRight,
  KeyRound,
  Network,
  Search,
  Unplug,
  UsersRound,
} from "lucide-react";
import { Badge, Empty, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { formatTime, grantLabels, isExpiring, vpnTimezone } from "./ocserv";
import type { VPNDialog, VPNGrant, VPNProfile, VPNState } from "./ocserv";

export function GrantStatus({ value }: { value: string }) {
  const tone = {
    active: "healthy",
    pending: "warning",
    revoked: "disabled",
    expired: "stale",
  }[value];
  return (
    <Badge value={tone || "unknown"}>
      {grantLabels[value] || "Статус неизвестен"}
    </Badge>
  );
}
export function Subject({
  grant,
  onClick,
  selected,
}: {
  grant: VPNGrant;
  selected?: boolean;
  onClick: () => void;
}) {
  const name = grant.display_name || grant.subject;
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase("ru");
  return (
    <button
      type="button"
      aria-label={"Открыть доступ: " + name}
      aria-pressed={selected}
      className="vpn-subject"
      onClick={onClick}
    >
      <span className="vpn-initials" aria-hidden="true">
        {initials}
      </span>
      <span>
        <strong>{name}</strong>
        {grant.display_name && grant.display_name !== grant.subject && (
          <small>{grant.subject}</small>
        )}
      </span>
    </button>
  );
}
export function Term({ grant }: { grant: VPNGrant }) {
  if (
    grant.status === "revoked" ||
    grant.status === "expired" ||
    grant.status === "pending"
  )
    return <GrantStatus value={grant.status} />;
  return grant.expires_at ? (
    <time dateTime={grant.expires_at} title={vpnTimezone}>
      {formatTime(grant.expires_at)}
    </time>
  ) : (
    <>Без срока</>
  );
}
export function SessionCount({
  count,
  known,
}: {
  count: number;
  known: boolean;
}) {
  return (
    <span className={known && count > 0 ? "vpn-connected" : "muted"}>
      {!known ? "Нет данных" : count || "Нет сессий"}
    </span>
  );
}
function GrantDetail({
  grant,
  profile,
  data,
  disabled,
  onOpen,
  onProfile,
}: {
  grant: VPNGrant;
  profile?: VPNProfile;
  data: VPNState;
  disabled: boolean;
  onOpen: (dialog: VPNDialog) => void;
  onProfile: (id: string) => void;
}) {
  const sessions = data.sessions.filter(
    (session) => session.subject === grant.subject,
  );
  const effective = grant.status === "active" && data.gateway.ready;
  return (
    <Panel
      title="Карточка доступа"
      icon={<KeyRound size={18} />}
      action={<GrantStatus value={grant.status} />}
    >
      <div className="vpn-identity">
        <strong>{grant.display_name || grant.subject}</strong>
        <span>{grant.subject}</span>
      </div>
      <dl className="vpn-facts">
        <div>
          <dt>Профиль</dt>
          <dd>
            {profile ? (
              <button
                className="vpn-link"
                onClick={() => onProfile(profile.id)}
              >
                {profile.name}
              </button>
            ) : (
              grant.profile_id
            )}
          </dd>
        </div>
        <div>
          <dt>Срок доступа</dt>
          <dd>
            {grant.expires_at ? formatTime(grant.expires_at) : "Без срока"}
          </dd>
        </div>
      </dl>
      <div className="vpn-detail-section">
        <h3>
          <Network size={16} />
          {effective ? "Разрешённые сети" : "Сети профиля"}
        </h3>
        {profile?.networks.length ? (
          <ul className="vpn-net-list">
            {profile.networks.map((cidr) => (
              <li key={cidr}>
                <code>{cidr}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Нет назначенных сетей.</p>
        )}
      </div>
      <div className="vpn-detail-section">
        <h3>
          <Activity size={16} />
          Активные сессии
        </h3>
        {!data.gateway.sessions_known ? (
          <p className="muted">Шлюз не передал список сессий.</p>
        ) : sessions.length ? (
          <ul className="vpn-session-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>{s.device || "Клиент VPN"}</strong>
                  <small>
                    {s.ip || "Адрес не передан"} · {formatTime(s.since)}
                  </small>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={disabled}
                  title="Завершить сессию"
                  aria-label={"Завершить сессию " + s.id}
                  onClick={() => onOpen({ kind: "terminate", session: s })}
                >
                  <Unplug size={15} />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Открытых сессий нет.</p>
        )}
      </div>
      <div className="vpn-detail-actions">
        <Button
          disabled={disabled || !data.profiles.length}
          onClick={() => onOpen({ kind: "grant", subject: grant.subject })}
        >
          {["revoked", "expired"].includes(grant.status)
            ? "Выдать повторно"
            : "Изменить доступ"}
        </Button>
        {grant.status !== "revoked" && (
          <Button
            variant="ghost"
            className="vpn-danger"
            disabled={disabled}
            onClick={() => onOpen({ kind: "revoke", subject: grant.subject })}
          >
            Отозвать доступ
          </Button>
        )}
      </div>
    </Panel>
  );
}

type Filter =
  | "all"
  | "active"
  | "sessions"
  | "expiring"
  | "pending"
  | "revoked"
  | "expired";
export default function OcservEmployees({
  data,
  selectedSubject,
  onSelect,
  onProfile,
  onOpen,
  disabled,
}: {
  data: VPNState;
  selectedSubject: string;
  onSelect: (subject: string) => void;
  onProfile: (id: string) => void;
  onOpen: (dialog: VPNDialog) => void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState(""),
    [profileID, setProfileID] = useState(""),
    [filter, setFilter] = useState<Filter>("all"),
    [page, setPage] = useState(() =>
      Math.max(
        0,
        Math.floor(
          data.grants.findIndex((g) => g.subject === selectedSubject) / 40,
        ),
      ),
    );
  const now = Date.now(),
    known = data.gateway.sessions_known;
  const profiles = new Map(data.profiles.map((p) => [p.id, p]));
  const counts = new Map<string, number>();
  for (const s of data.sessions)
    counts.set(s.subject, (counts.get(s.subject) || 0) + 1);
  const q = search.trim().toLocaleLowerCase("ru");
  const rows = data.grants.filter(
    (g) =>
      (!profileID || profileID === g.profile_id) &&
      (!q ||
        [g.subject, g.display_name].some((v) =>
          v.toLocaleLowerCase("ru").includes(q),
        )) &&
      (filter === "all" ||
        (filter === "sessions"
          ? known && counts.has(g.subject)
          : filter === "expiring"
            ? isExpiring(g, now)
            : g.status === filter)),
  );
  const pageSize = 40,
    lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1),
    currentPage = Math.min(page, lastPage);
  const slice = rows.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const picked = slice.find((g) => g.subject === selectedSubject) || slice[0];
  function chooseFilter(value: Filter) {
    setFilter(value);
    setPage(0);
  }
  function metricFilter(value: Filter) {
    setSearch("");
    setProfileID("");
    chooseFilter(filter === value ? "all" : value);
  }
  return (
    <>
      <section
        className="pl-ui-panel vpn-stats"
        aria-label="Сводка по доступам"
      >
        <button
          aria-pressed={filter === "active"}
          onClick={() => metricFilter("active")}
        >
          <UsersRound />
          <span>
            <b>{data.grants.filter((g) => g.status === "active").length}</b>
            <small>Сотрудники с доступом</small>
          </span>
          <ChevronRight size={14} />
        </button>
        <button
          disabled={!known}
          aria-pressed={filter === "sessions"}
          onClick={() => metricFilter("sessions")}
        >
          <Activity />
          <span>
            <b>{known ? data.sessions.length : "—"}</b>
            <small>{known ? "Активные сессии" : "Сессии недоступны"}</small>
          </span>
          <ChevronRight size={14} />
        </button>
        <button
          aria-pressed={filter === "expiring"}
          onClick={() => metricFilter("expiring")}
        >
          <CalendarClock />
          <span>
            <b>{data.grants.filter((g) => isExpiring(g, now)).length}</b>
            <small>Истекают за 7 дней</small>
          </span>
          <ChevronRight size={14} />
        </button>
      </section>
      <div className="vpn-employees-layout">
        <Panel
          title="Доступ сотрудников"
          icon={<UsersRound size={18} />}
          action={<small className="muted">{rows.length}</small>}
        >
          {data.grants.length > 0 && (
            <div className="vpn-filters">
              <Field label="Поиск сотрудника">
                <div className="vpn-search">
                  <Search size={15} />
                  <input
                    type="search"
                    placeholder="Имя или идентификатор"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(0);
                    }}
                  />
                </div>
              </Field>
              <Field label="Профиль">
                <select
                  value={profileID}
                  onChange={(e) => {
                    setProfileID(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">Все профили</option>
                  {data.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Состояние">
                <select
                  value={filter}
                  onChange={(e) => chooseFilter(e.target.value as Filter)}
                >
                  <option value="all">Все доступы</option>
                  <option value="active">Действующие</option>
                  <option value="sessions" disabled={!known}>
                    С активной сессией
                  </option>
                  <option value="expiring">Истекают за 7 дней</option>
                  <option value="pending">Ожидают применения</option>
                  <option value="revoked">Отозванные</option>
                  <option value="expired">Истёкшие</option>
                </select>
              </Field>
            </div>
          )}
          {slice.length ? (
            <div className="vpn-scroll">
              <table className="vpn-table">
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th>Профиль</th>
                    <th>Сессии</th>
                    <th>Доступ до</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.map((g) => (
                    <tr
                      key={g.subject}
                      className={
                        picked?.subject === g.subject ? "vpn-picked" : ""
                      }
                    >
                      <td>
                        <Subject
                          grant={g}
                          selected={g.subject === picked?.subject}
                          onClick={() => onSelect(g.subject)}
                        />
                      </td>
                      <td>
                        {profiles.get(g.profile_id)?.name || g.profile_id}
                      </td>
                      <td>
                        <SessionCount
                          count={counts.get(g.subject) || 0}
                          known={known}
                        />
                      </td>
                      <td>
                        <Term grant={g} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title={
                data.grants.length
                  ? "Сотрудники не найдены"
                  : "Доступ ещё никому не выдан"
              }
              detail={
                data.grants.length
                  ? undefined
                  : !data.profiles.length
                    ? "Создайте профиль с разрешёнными подсетями."
                    : "Выберите сотрудника и назначьте ему профиль."
              }
              action={
                data.grants.length ? (
                  <Button
                    onClick={() => {
                      setSearch("");
                      setProfileID("");
                      chooseFilter("all");
                    }}
                  >
                    Сбросить фильтры
                  </Button>
                ) : !data.profiles.length ? (
                  <Button
                    disabled={disabled}
                    onClick={() => onOpen({ kind: "profile" })}
                  >
                    Создать профиль
                  </Button>
                ) : undefined
              }
            />
          )}
          {lastPage > 0 && (
            <div className="vpn-pages">
              <Button
                size="sm"
                disabled={!currentPage}
                onClick={() => setPage(currentPage - 1)}
              >
                Назад
              </Button>
              <small>
                {currentPage * pageSize + 1}–
                {Math.min((currentPage + 1) * pageSize, rows.length)} из{" "}
                {rows.length}
              </small>
              <Button
                size="sm"
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
              >
                Далее
              </Button>
            </div>
          )}
        </Panel>
        {picked && (
          <GrantDetail
            grant={picked}
            profile={profiles.get(picked.profile_id)}
            data={data}
            onProfile={onProfile}
            onOpen={onOpen}
            disabled={disabled}
          />
        )}
      </div>
    </>
  );
}
