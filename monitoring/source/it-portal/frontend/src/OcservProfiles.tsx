import { useMemo, useState } from "react";
import {
  Check,
  CircleMinus,
  Minus,
  Network,
  Pencil,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Empty, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { GrantStatus, Subject } from "./OcservEmployees";
import { cidrRange, networkAccess } from "./ocserv";
import type { IPV4Range, VPNDialog, VPNState } from "./ocserv";

export default function OcservProfiles({
  data,
  selectedID,
  onSelect,
  onMember,
  onOpen,
  disabled,
}: {
  data: VPNState;
  selectedID: string;
  onSelect: (id: string) => void;
  onMember: (subject: string) => void;
  onOpen: (dialog: VPNDialog) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0);
  const [memberPage, setMemberPage] = useState(0);
  const matrix = useMemo(() => {
    const networks = new Map<string, IPV4Range | undefined>();
    const rules = new Map<string, IPV4Range[]>();
    for (const p of data.profiles) {
      for (const cidr of p.networks)
        if (!networks.has(cidr)) networks.set(cidr, cidrRange(cidr));
      const ranges = p.networks.map((cidr) => networks.get(cidr));
      if (ranges.every((r): r is IPV4Range => !!r))
        rules.set(
          p.id,
          ranges.sort((a, b) => a[0] - b[0]),
        );
    }
    const rows = [...networks.keys()].sort(
      (a, b) =>
        (networks.get(a)?.[0] ?? 0) - (networks.get(b)?.[0] ?? 0) ||
        a.localeCompare(b, "ru", { numeric: true }),
    );
    return { rows, networks, rules };
  }, [data.profiles]);
  const selected =
    data.profiles.find((p) => p.id === selectedID) || data.profiles[0];
  if (!selected)
    return (
      <Panel title="Матрица доступа" icon={<Network size={18} />}>
        <Empty
          title="Профилей доступа пока нет"
          detail="В каждом профиле указываются разрешённые IPv4-подсети."
        />
      </Panel>
    );
  const all = matrix.rows;
  const rows = all.filter((cidr) => cidr.includes(query.trim()));
  const pageSize = 35,
    lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1),
    current = Math.min(page, lastPage);
  const members = data.grants.filter(
    (g) =>
      g.profile_id === selected.id &&
      g.status !== "revoked" &&
      g.status !== "expired",
  );
  const memberLimit = 40,
    lastMember = Math.max(0, Math.ceil(members.length / memberLimit) - 1);
  const currentMember = Math.min(memberPage, lastMember);
  return (
    <>
      <Panel
        title="Матрица доступа"
        icon={<Network size={18} />}
        action={
          <small className="muted">
            Подсетей: {all.length} · Профилей: {data.profiles.length}
          </small>
        }
      >
        {all.length > pageSize && (
          <Field label="Поиск подсети">
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </Field>
        )}
        <div className="vpn-scroll">
          <table className="vpn-table vpn-matrix">
            <thead>
              <tr>
                <th scope="col">Корпоративная сеть</th>
                {data.profiles.map((p) => (
                  <th
                    key={p.id}
                    scope="col"
                    className={p.id === selected.id ? "vpn-picked" : ""}
                  >
                    <button
                      className="vpn-select-profile"
                      aria-pressed={selected.id === p.id}
                      onClick={() => {
                        setMemberPage(0);
                        onSelect(p.id);
                      }}
                    >
                      {p.name}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows
                .slice(current * pageSize, (current + 1) * pageSize)
                .map((cidr) => (
                  <tr key={cidr}>
                    <th scope="row">
                      <code>{cidr}</code>
                    </th>
                    {data.profiles.map((p) => {
                      const access = networkAccess(
                        matrix.networks.get(cidr),
                        matrix.rules.get(p.id),
                      );
                      return (
                        <td
                          key={p.id}
                          className={p.id === selected.id ? "vpn-picked" : ""}
                        >
                          {access === "allowed" ? (
                            <span className="vpn-permit">
                              <Check size={14} />
                              Разрешено
                            </span>
                          ) : access === "partial" ? (
                            <span className="vpn-partial">
                              <CircleMinus size={14} />
                              Частично
                            </span>
                          ) : access === "closed" ? (
                            <span className="vpn-deny">
                              <Minus size={14} />
                              Закрыто
                            </span>
                          ) : (
                            "Нет данных"
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!rows.length && <Empty title="Подсети не найдены" />}
        {lastPage > 0 && (
          <div className="vpn-pages">
            <Button
              size="sm"
              disabled={!current}
              onClick={() => setPage(current - 1)}
            >
              Назад
            </Button>
            <small>
              {current * pageSize + 1}–
              {Math.min((current + 1) * pageSize, rows.length)} из {rows.length}
            </small>
            <Button
              size="sm"
              disabled={current === lastPage}
              onClick={() => setPage(current + 1)}
            >
              Далее
            </Button>
          </div>
        )}
      </Panel>
      <div className="vpn-profiles-layout">
        <Panel
          title="Кому назначен профиль"
          icon={<UsersRound size={18} />}
          action={<small>{selected.name}</small>}
        >
          {members.length ? (
            <div className="vpn-scroll">
              <table className="vpn-table">
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th>Доступ</th>
                  </tr>
                </thead>
                <tbody>
                  {members
                    .slice(
                      currentMember * memberLimit,
                      (currentMember + 1) * memberLimit,
                    )
                    .map((g) => (
                      <tr key={g.subject}>
                        <td>
                          <Subject
                            grant={g}
                            onClick={() => onMember(g.subject)}
                          />
                        </td>
                        <td>
                          <GrantStatus value={g.status} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Этот профиль пока никому не назначен.</p>
          )}
          {lastMember > 0 && (
            <div className="vpn-pages">
              <Button
                size="sm"
                disabled={!currentMember}
                onClick={() => setMemberPage(currentMember - 1)}
              >
                Назад
              </Button>
              <small>
                {currentMember * memberLimit + 1}–
                {Math.min((currentMember + 1) * memberLimit, members.length)} из{" "}
                {members.length}
              </small>
              <Button
                size="sm"
                disabled={currentMember === lastMember}
                onClick={() => setMemberPage(currentMember + 1)}
              >
                Далее
              </Button>
            </div>
          )}
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => onOpen({ kind: "grant", profile: selected.id })}
          >
            Выдать доступ с этим профилем
          </Button>
        </Panel>
        <Panel
          title="Параметры профиля"
          icon={<ShieldCheck size={18} />}
          action={
            <Button
              disabled={disabled}
              size="sm"
              onClick={() => onOpen({ kind: "profile", id: selected.id })}
            >
              <Pencil size={14} /> Изменить профиль
            </Button>
          }
        >
          <dl className="vpn-facts">
            <div>
              <dt>Название</dt>
              <dd>{selected.name}</dd>
            </div>
            <div>
              <dt>Идентификатор</dt>
              <dd>
                <code>{selected.id}</code>
              </dd>
            </div>
          </dl>
          <div className="vpn-detail-section">
            <h3>Разрешённые сети</h3>
            <ul className="vpn-net-list">
              {selected.networks.map((cidr) => (
                <li key={cidr}>
                  <code>{cidr}</code>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>
    </>
  );
}
