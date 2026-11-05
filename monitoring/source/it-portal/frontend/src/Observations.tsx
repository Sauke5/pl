import { InventorySummary } from "./Inventory";
import { ProblemLinks } from "./ProblemLinks";
import { useHelpTopic } from "./Help";
import {
  isProblemMuted,
  isProblemSuppressed,
  requiresAttention,
} from "./problemVisibility";
import { ru } from "./ru";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Link,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Eye,
  EyeOff,
} from "lucide-react";
import { api, APIError, useAPI, refresh, date } from "./api";
import type {
  Problem,
  Integration,
  Resource,
  PortalEvent,
  Candidate,
  Session,
} from "./types";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import {
  Badge,
  Empty,
  ErrorBox,
  ExternalLink,
  Field,
  JSONView,
  Panel,
} from "./components/common";
import { copy } from "./copy";
function ProblemVisibilityBadges({ problem }: { problem: Problem }) {
  const silenced = problem.labels?.portal_silenced === "true";
  const inhibited =
    problem.labels?.portal_inhibited === "true" ||
    (problem.labels?.portal_alert_state === "suppressed" && !silenced);
  if (!problem.hidden && !silenced && !inhibited) return null;
  return (
    <span className="problem-visibility-badges">
      {problem.hidden && (
        <span className="badge status-unknown">{ru.problem_hidden}</span>
      )}
      {silenced && (
        <span className="badge status-unknown">{ru.problem_silenced}</span>
      )}
      {inhibited && (
        <span className="badge status-unknown">{ru.problem_inhibited}</span>
      )}
    </span>
  );
}
export function ProblemRows({
  problems,
  onSelect,
  resources,
  limit,
}: {
  problems: Problem[];
  onSelect: (p: Problem) => void;
  resources: Resource[];
  limit?: number;
}) {
  return (
    <div>
      {problems.slice(0, limit).map((p) => (
        <button className="problem-row" key={p.id} onClick={() => onSelect(p)}>
          <span className={`severity-dot severity-${p.severity}`}>
            <AlertTriangle size={13} />
          </span>
          <span className="problem-text">
            <strong>{p.title}</strong>
            <small>
              {resources.find((r) => r.id === p.resource_id)?.name ||
                ru.ne_svyazan_s_resursom}
              {p.stale ? ru.ustarevshie_dannye : ""}
            </small>
            <ProblemVisibilityBadges problem={p} />
          </span>
          <span className="problem-meta">
            <Badge value={p.severity} />
            <time>{date(p.last_seen)}</time>
          </span>
          <ArrowRight size={14} />
        </button>
      ))}
    </div>
  );
}
export function ProblemDetail({
  problem: p,
  integrations,
  resources,
  onClose,
  onResource,
}: {
  problem: Problem;
  integrations: Integration[];
  resources: Resource[];
  onClose: () => void;
  onResource: (r: Resource) => void;
}) {
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const session = useAPI<Session>("/session");
  async function changeVisibility() {
    setVisibilityBusy(true);
    setError(undefined);
    setRestored(false);
    try {
      const hidden = !p.hidden;
      await api(`/problems/${p.id}/visibility`, "PUT", {
        hidden,
        expected_started_at: p.started_at,
      });
      await refresh();
      setRestored(!hidden && isProblemSuppressed(p));
    } catch (e) {
      setError(e);
      if (e instanceof APIError && e.status === 409) await refresh();
    } finally {
      setVisibilityBusy(false);
    }
  }
  const integration = integrations.find((i) => i.id === p.integration_id);
  const linkedIDs = p.resource_ids?.length
    ? p.resource_ids
    : p.resource_id
      ? [p.resource_id]
      : [];
  const linkedResources = resources.filter((resource) =>
    linkedIDs.includes(resource.id),
  );
  const resource = linkedResources[0];
  async function refreshSource() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/integrations/${p.integration_id}/refresh`, "POST", {});
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog helpTopic="problem-details" title={p.title} onClose={onClose}>
      <div className="actions">
        <Badge value={p.status} />
        <Badge value={p.severity} />
        {p.stale && <Badge value="stale" />}
        <ProblemVisibilityBadges problem={p} />
      </div>
      <p>{p.description || ru.istochnik_ne_peredal_opisanie}</p>
      <dl className="detail-grid">
        <div>
          <dt>{ru.istochnik}</dt>
          <dd>{integration?.name || p.integration_id}</dd>
        </div>
        <div>
          <dt>{ru.podklyuchenie}</dt>
          <dd>
            <Badge value={integration?.status || "unknown"} />
          </dd>
        </div>
        <div>
          <dt>{ru.nachalo}</dt>
          <dd>{date(p.started_at)}</dd>
        </div>
        <div>
          <dt>{ru.poslednee_podtverzhdenie}</dt>
          <dd>{date(p.last_seen)}</dd>
        </div>
        <div>
          <dt>{ru.vosstanovlenie}</dt>
          <dd>{p.resolved_at ? date(p.resolved_at) : ru.ne_podtverzhdeno}</dd>
        </div>
      </dl>
      {p.stale && (
        <p className="notice">
          {ru.istochnik_davno_ne_podtverdil_sostoyanie_poslednyaya_izvestnay}
        </p>
      )}
      <div className="actions">
        {linkedResources.length ? (
          linkedResources.map((resource) => (
            <Button key={resource.id} onClick={() => onResource(resource)}>
              {resource.name}
              <ArrowRight size={15} />
            </Button>
          ))
        ) : (
          <span className="muted">{ru.ne_svyazan_s_resursom}</span>
        )}
        {p.source_url && (
          <ExternalLink url={p.source_url} className="button">
            {ru.otkryt_istochnik}
          </ExternalLink>
        )}
        {resource?.links?.map((l, i) => (
          <ExternalLink key={i} url={l.url} className="button">
            {l.name}
          </ExternalLink>
        ))}
      </div>
      {p.link_reason && <p className="muted">{p.link_reason}</p>}
      {session.data?.user?.admin && (
        <Button onClick={() => setLinking(true)}>
          <Link size={16} />
          {ru.links_title}
        </Button>
      )}
      {linking && (
        <ProblemLinks
          problem={p}
          resources={resources}
          onClose={() => setLinking(false)}
        />
      )}
      <details className="form-section">
        <summary>{ru.dannye_istochnika}</summary>
        <JSONView value={{ external_id: p.external_id, labels: p.labels }} />
      </details>
      {session.data?.user?.admin && p.status === "firing" && (
        <div className="problem-visibility-control">
          <p className="muted">{ru.problem_visibility_note}</p>
          <Button
            disabled={busy || visibilityBusy}
            onClick={() => void changeVisibility()}
          >
            {p.hidden ? <Eye size={16} /> : <EyeOff size={16} />}
            {visibilityBusy
              ? ru.problem_visibility_saving
              : p.hidden
                ? ru.problem_restore
                : ru.problem_hide}
          </Button>
        </div>
      )}
      {restored && (
        <p className="notice" role="status">
          {ru.problem_restore_suppressed}
        </p>
      )}
      {!!error && <ErrorBox error={error} />}
      <div className="dialog-footer">
        <Button
          disabled={busy || visibilityBusy}
          onClick={() => void refreshSource()}
        >
          <RefreshCw size={15} />
          {ru.povtorno_poluchit_dannye_istochnika}
        </Button>
      </div>
    </Dialog>
  );
}
export function Problems({
  onResource,
}: {
  onResource: (r: Resource) => void;
}) {
  const problems = useAPI<Problem[]>("/problems");
  const integrations = useAPI<Integration[]>("/integrations");
  const resources = useAPI<Resource[]>("/resources");
  const [status, setStatus] = useState("");
  const [visibility, setVisibility] = useState("attention");
  const [severity, setSeverity] = useState("");
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Problem>();
  const matching =
    problems.data?.filter(
      (p) =>
        (!status || p.status === status) &&
        (!severity || p.severity === severity) &&
        (!source || p.integration_id === source) &&
        `${p.title} ${p.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) || [];
  const counts = {
    attention: matching.filter(requiresAttention).length,
    muted: matching.filter(isProblemMuted).length,
    all: matching.length,
  };
  const filtered = matching.filter((p) =>
    visibility === "attention"
      ? requiresAttention(p)
      : visibility === "muted"
        ? isProblemMuted(p)
        : true,
  );
  const sources =
    integrations.data?.filter((i) => i.kind === "alertmanager") || [];
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{copy.problems}</h1>
          <p>
            {ru.sostoyanie_istochnikov_aktualnost_dannyh_i_svyazannye_resursy}
          </p>
        </div>
        <span className="count-pill">
          {filtered.length}
          {" " + ru.zapisey}
        </span>
      </div>
      <div className="source-strip">
        {sources.length ? (
          sources.map((i) => (
            <div key={i.id}>
              <strong>{i.name}</strong>
              <Badge value={i.status} />
              <small>
                {ru.posledniy_uspeh + " "}
                {date(i.last_success)}
              </small>
              {i.error && <span className="text-danger">{i.error}</span>}
            </div>
          ))
        ) : (
          <p className="notice">
            {ru.alertmanager_ne_podklyuchyon_sostoyanie_infrastruktury_neizves}
          </p>
        )}
      </div>
      <div
        className="segmented problem-visibility-tabs"
        role="group"
        aria-label={ru.problem_visibility}
      >
        {(
          [
            ["attention", ru.problems_attention],
            ["muted", ru.problems_muted],
            ["all", ru.vse],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={visibility === value ? "default" : "ghost"}
            aria-pressed={visibility === value}
            onClick={() => setVisibility(value)}
          >
            {label} <span className="visibility-count">{counts[value]}</span>
          </Button>
        ))}
      </div>
      <div className="filter-bar">
        <div className="input-icon">
          <Search size={16} />
          <input
            aria-label={ru.poisk_problem}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ru.poisk_po_problemam}
          />
        </div>
        <select
          aria-label={ru.sostoyanie_problemy}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            if (e.target.value === "resolved") setVisibility("all");
          }}
        >
          <option value="firing">{ru.aktivnye}</option>
          <option value="resolved">{ru.vosstanovlennye}</option>
          <option value="">{ru.vse_sostoyaniya}</option>
        </select>
        <select
          aria-label={ru.vazhnost}
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          <option value="">{ru.lyubaya_vazhnost}</option>
          <option value="critical">{ru.kritichno}</option>
          <option value="warning">{ru.preduprezhdenie}</option>
          <option value="info">{ru.informatsiya}</option>
        </select>
        <select
          aria-label={ru.istochnik_problem}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">{ru.vse_istochniki}</option>
          {sources.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>
      <Panel title={ru.problemy} icon={<AlertTriangle size={20} />}>
        {problems.error ? (
          <ErrorBox error={problems.error} />
        ) : filtered.length ? (
          <ProblemRows
            problems={filtered}
            resources={resources.data || []}
            onSelect={setSelected}
          />
        ) : (
          <Empty
            title={ru.net_zapisey_dlya_etih_usloviy}
            detail={
              sources.length
                ? ru.proverte_svezhest_istochnikov_vyshe_otsutstvie_zapisey_samo_po
                : ru.nastroyte_istochnik_aktualnyh_problem
            }
          />
        )}
      </Panel>
      {selected && (
        <ProblemDetail
          problem={problems.data?.find((p) => p.id === selected.id) || selected}
          resources={resources.data || []}
          integrations={integrations.data || []}
          onClose={() => setSelected(undefined)}
          onResource={(r) => {
            setSelected(undefined);
            onResource(r);
          }}
        />
      )}
    </>
  );
}
function eventActor(event: PortalEvent) {
  if (event.actor_name?.trim()) return event.actor_name;
  if (event.actor === "system") return ru.actor_system;
  if (event.actor === "local-admin") return ru.actor_local_admin;
  return ru.actor_name_missing;
}
export function EventRows({
  events,
  limit,
}: {
  events: PortalEvent[];
  limit?: number;
}) {
  return (
    <div>
      {events.slice(0, limit).map((e) => (
        <div className="event-row" key={e.id}>
          <span className="event-dot" />
          <div>
            <strong>{e.title}</strong>
            <small>{eventActor(e)}</small>
          </div>
          <time>{date(e.created_at)}</time>
        </div>
      ))}
    </div>
  );
}
export function Events() {
  const [audit, setAudit] = useState(false);
  useHelpTopic(audit ? "audit" : "events", 1);
  const data = useAPI<PortalEvent[]>(audit ? "/audit" : "/events");
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{copy.events}</h1>
          <p>
            {ru.poleznye_izmeneniya_infrastruktury_i_otdelnyy_audit_deystviy}
          </p>
        </div>
        <div className="segmented">
          <Button
            variant={!audit ? "default" : "ghost"}
            onClick={() => setAudit(false)}
          >
            {ru.sobytiya}
          </Button>
          <Button
            variant={audit ? "default" : "ghost"}
            onClick={() => setAudit(true)}
          >
            {ru.audit}
          </Button>
        </div>
      </div>
      <Panel title={audit ? ru.audit_deystviy : ru.nedavnie_sobytiya}>
        {data.error ? (
          <ErrorBox error={data.error} />
        ) : data.data?.length ? (
          data.data.map((e) => (
            <details className="event-detail" key={e.id}>
              <summary>
                <span>{e.title}</span>
                <span className="muted">
                  {eventActor(e)} · {date(e.created_at)}
                </span>
              </summary>
              <JSONView
                value={audit ? { actor_id: e.actor, ...e.details } : e.details}
              />
            </details>
          ))
        ) : (
          <Empty title={ru.sobytiy_poka_net} />
        )}
      </Panel>
    </>
  );
}
export function Candidates() {
  const candidates = useAPI<Candidate[]>("/candidates");
  const resources = useAPI<Resource[]>("/resources");
  const integrations = useAPI<Integration[]>("/integrations");
  const [selected, setSelected] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [state, setState] = useState("pending");
  const [linkTo, setLinkTo] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const sourceCandidates =
    candidates.data?.filter((c) => !source || c.integration_id === source) ||
    [];
  const filtered = sourceCandidates.filter((c) => !state || c.state === state);
  const ignoredCount = sourceCandidates.filter(
    (c) => c.state === "ignored",
  ).length;
  const selectedCandidates = filtered.filter((c) => selected.includes(c.id));
  const canResolve =
    selectedCandidates.length > 0 &&
    selectedCandidates.every((c) => c.state === "pending");
  const canRestore =
    selectedCandidates.length > 0 &&
    selectedCandidates.every((c) => c.state === "ignored");
  async function resolve(action: string) {
    setBusy(true);
    try {
      await api("/candidates/resolve", "POST", {
        ids: selected,
        action,
        resource_id: action === "link" ? linkTo : undefined,
      });
      setSelected([]);
      setLinking(false);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{copy.candidates}</h1>
          <p>
            {ru.podtverdite_novye_resursy_ili_svyazhite_tehnicheskie_obekty_s_}
          </p>
        </div>
        <ScanLine size={27} className="text-blue" />
      </div>
      <div className="filter-bar">
        <select
          aria-label={ru.sostoyanie_kandidata}
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setSelected([]);
          }}
        >
          <option value="pending">{ru.novye}</option>
          <option value="linked">{ru.svyazannye}</option>
          <option value="ignored">{ru.ignoriruemye}</option>
          <option value="">{ru.vse}</option>
        </select>
        <select
          aria-label="Источник кандидатов"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setSelected([]);
            setLinking(false);
          }}
        >
          <option value="">Все источники</option>
          {integrations.data?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <span className="muted">Показано: {filtered.length}</span>
        <span className="muted">
          {ru.vybrano + " "}
          {selected.length}
        </span>
        <Button
          disabled={!canResolve || busy}
          onClick={() => void resolve("add")}
        >
          <Plus size={16} />
          {ru.v_katalog}
        </Button>
        <Button disabled={!canResolve || busy} onClick={() => setLinking(true)}>
          <Link size={16} />
          {ru.svyazat}
        </Button>
        <Button
          disabled={!canResolve || busy}
          onClick={() => void resolve("ignore")}
        >
          {ru.ignorirovat}
        </Button>
        {state === "ignored" && (
          <Button
            disabled={!canRestore || busy}
            onClick={() => void resolve("restore")}
          >
            Вернуть в новые
          </Button>
        )}
      </div>
      {state === "pending" && !filtered.length && ignoredCount > 0 && (
        <p className="muted">
          Ранее скрыто кандидатов: {ignoredCount}. Откройте «Игнорируемые» и
          выберите «Вернуть в новые», чтобы рассмотреть их повторно.
        </p>
      )}
      {!!error && <ErrorBox error={error} />}
      <Panel title={ru.kandidaty}>
        {candidates.error ? (
          <ErrorBox error={candidates.error} />
        ) : filtered.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={ru.vybrat_vseh_kandidatov}
                      checked={
                        filtered.length > 0 &&
                        filtered.every((c) => selected.includes(c.id))
                      }
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? filtered.map((c) => c.id) : [],
                        )
                      }
                    />
                  </th>
                  <th>{ru.obekt}</th>
                  <th>{ru.istochnik}</th>
                  <th>{ru.poslednee_obnaruzhenie}</th>
                  <th>{ru.sostoyanie}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={ru.vybrat + c.name}
                        checked={selected.includes(c.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, c.id]
                              : selected.filter((id) => id !== c.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <strong>{c.name}</strong>
                      <InventorySummary inventory={c.inventory} />
                      <small className="break">{c.url}</small>
                      <details>
                        <summary>{ru.labels_i_vneshnyaya_svyaz}</summary>
                        <JSONView
                          value={{
                            external_id: c.external_id,
                            labels: c.labels,
                            resource:
                              resources.data?.find(
                                (r) => r.id === c.resource_id,
                              )?.name || c.resource_id,
                          }}
                        />
                      </details>
                    </td>
                    <td>
                      {integrations.data?.find((i) => i.id === c.integration_id)
                        ?.name || c.integration_id}
                    </td>
                    <td>{date(c.last_seen)}</td>
                    <td>
                      <Badge value={c.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={ru.net_kandidatov}
            detail={
              source
                ? "В выбранном источнике нет кандидатов с этим состоянием. Измените фильтр или обновите источник в настройках интеграций."
                : "Нет кандидатов с выбранным состоянием. Измените фильтр или обновите источники в настройках интеграций."
            }
          />
        )}
      </Panel>
      {linking && (
        <Dialog
          helpTopic="candidate-link"
          title={ru.svyazat_s_resursom}
          description={
            ru.neskolko_technical_targets_mogut_prinadlezhat_odnomu_resursu_k
          }
          onClose={() => setLinking(false)}
        >
          <Field label={ru.resurs}>
            <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
              <option value="">{ru.vyberite_resurs}</option>
              {resources.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          {!!error && <ErrorBox error={error} />}
          <div className="dialog-footer">
            <Button
              variant="default"
              disabled={!linkTo || busy}
              onClick={() => void resolve("link")}
            >
              {ru.svyazat + " "}
              {selected.length}
              {" " + ru.obektov}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
