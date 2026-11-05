import { ru } from "./ru";
import { useEffect, useRef, useState } from "react";
import { resourceKind, type ResourceKind } from "./resourceKind";
import "./catalog-views.css";
import { isServiceCardResource } from "./serviceCardEligibility";
import { SystemsCatalog } from "./Systems";
import type { SystemDefinition } from "./workspaceTypes";
import {
  Plus,
  Star,
  SlidersHorizontal,
  Upload,
  Download,
  FolderPlus,
  ArrowRight,
  ArrowUpRight,
  Copy,
  Search,
  MoreHorizontal,
} from "lucide-react";
import { api, useAPI, params, refresh, date, safeURL } from "./api";
import type {
  Resource,
  Preferences,
  Dictionaries,
  Collection,
  Filter,
  ImportPreview,
} from "./types";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import {
  Badge,
  Empty,
  ErrorBox,
  Field,
  Panel,
  ResourceIcon,
} from "./components/common";
import { copy } from "./copy";
export type ResourceActions = {
  onDetails: (resource: Resource) => void;
  onEdit: (resource?: Resource) => void;
  onOperation: (kind: string, resource?: Resource) => void;
  preferences?: Preferences;
  onPreferences: (value: Preferences) => void;
};
export function ResourceRow({
  resource: r,
  onDetails,
  preferences,
  onPreferences,
}: ResourceActions & { resource: Resource }) {
  const starred = preferences?.favorites?.includes(r.id);
  const [copyState, setCopyState] = useState("");
  const href = safeURL(r.url);
  async function copyIP() {
    try {
      await navigator.clipboard.writeText(r.ip);
      setCopyState("IP скопирован");
    } catch {
      setCopyState("Не удалось скопировать IP");
    }
  }
  return (
    <div
      className="resource-row"
      role="row"
      tabIndex={0}
      aria-label={`Ресурс ${r.name}`}
      onClick={(event) => {
        if (
          !(event.target as HTMLElement).closest("button, a, input, select") &&
          !window.getSelection()?.toString()
        )
          onDetails(r);
      }}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          ["Enter", " "].includes(event.key)
        ) {
          event.preventDefault();
          onDetails(r);
        }
      }}
    >
      <div className="catalog-resource-identity" role="cell">
        <ResourceIcon
          type={r.type}
          name={r.name}
          url={r.url}
          manualIcon={r.icon}
        />
        <div className="resource-main">
          <button
            type="button"
            className="resource-detail-link resource-name"
            onClick={() => onDetails(r)}
          >
            {r.name}
          </button>
          <span title={r.description || r.hostname || r.url}>
            {r.description || r.hostname || r.url || "Без описания"}
          </span>
        </div>
      </div>
      <div className="catalog-resource-ip" role="cell">
        <span>{r.ip || "—"}</span>
        {r.ip && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Скопировать IP ${r.ip}`}
            title={copyState || "Скопировать IP"}
            onClick={() => void copyIP()}
          >
            <Copy size={15} />
          </Button>
        )}
        <span className="sr-only" role="status">
          {copyState}
        </span>
      </div>
      <div className="catalog-resource-direction" role="cell">
        {r.directions?.join(", ") || "—"}
      </div>
      <div className="resource-site" role="cell">
        {r.site || "—"}
      </div>
      <div className="catalog-resource-environment" role="cell">
        {r.environment ? <span className="tag">{r.environment}</span> : "—"}
      </div>
      <div className="catalog-resource-actions" role="cell">
        {isServiceCardResource(r) || starred ? (
          <Button
            variant="ghost"
            size="icon"
            disabled={!preferences}
            aria-label={(starred ? ru.otkrepit : ru.zakrepit) + " " + r.name}
            onClick={() =>
              preferences &&
              onPreferences({
                ...preferences,
                favorites: starred
                  ? preferences.favorites.filter((id) => id !== r.id)
                  : [...preferences.favorites, r.id],
              })
            }
          >
            <Star size={18} className={starred ? "starred" : ""} />
          </Button>
        ) : (
          <span className="catalog-action-placeholder" />
        )}
        {href ? (
          <a
            className="button button-ghost catalog-open-resource"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Открыть ${r.name}`}
            title={`Открыть ${r.name}`}
          >
            <ArrowUpRight size={18} />
          </a>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            disabled
            aria-label={`Нет адреса для открытия ${r.name}`}
          >
            <ArrowUpRight size={18} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDetails(r)}
          aria-label={ru.podrobnee + r.name}
        >
          <MoreHorizontal size={20} />
        </Button>
      </div>
    </div>
  );
}
export default function Catalog(props: ResourceActions) {
  const initial = new URLSearchParams(location.hash.split("?")[1] || "");
  const [filter, setFilter] = useState<Filter>({
    q: initial.get("q") || "",
    direction: initial.get("direction") || "",
    collection: initial.get("collection") || "",
    site: initial.get("site") || "",
    environment: initial.get("environment") || "",
    tag: initial.get("tag") || "",
    lifecycle: initial.has("lifecycle")
      ? initial.get("lifecycle") || ""
      : "active",
    sort: initial.get("sort") || "name",
  });
  const [chosenKind, setChosenKind] = useState<ResourceKind | "systems" | null>(
    initial.get("kind") === "systems"
      ? "systems"
      : initial.get("kind") === "infrastructure"
        ? "infrastructure"
        : initial.get("kind") === "applications"
          ? "applications"
          : null,
  );
  const [favoritesOnly, setFavoritesOnly] = useState(
    initial.get("favorites") === "true",
  );
  const [importing, setImporting] = useState(false);
  const [collection, setCollection] = useState<Collection | "new" | null>(null);
  const [error, setError] = useState<unknown>();
  const systems = useAPI<SystemDefinition[]>("/systems");
  const resources = useAPI<Resource[]>(`/resources?${params(filter)}`);
  const linkedResource = useRef("");
  const all = useAPI<Resource[]>(
    `/resources?${params({ lifecycle: filter.lifecycle })}`,
  );
  useEffect(() => {
    function openLinkedResource() {
      const id =
        new URLSearchParams(location.hash.split("?")[1] || "").get(
          "resource",
        ) || "";
      if (!id) {
        linkedResource.current = "";
        return;
      }
      if (linkedResource.current === id) return;
      const resource = all.data?.find((item) => item.id === id);
      if (resource) {
        linkedResource.current = id;
        props.onDetails(resource);
      }
    }
    openLinkedResource();
    window.addEventListener("hashchange", openLinkedResource);
    return () => window.removeEventListener("hashchange", openLinkedResource);
  }, [all.data, props.onDetails]);
  const dictionaries = useAPI<Dictionaries>("/dictionaries");
  const collections = useAPI<Collection[]>("/collections");
  // Old direction/collection links retain their useful destination. Explicit
  // selection always wins; normal catalog entry is the application launcher.
  const scoped = resources.data || [];
  const kind: ResourceKind | "systems" =
    chosenKind ||
    ((filter.direction || filter.collection) &&
    scoped.length > 0 &&
    scoped.every((r) => resourceKind(r) === "infrastructure")
      ? "infrastructure"
      : "applications");
  const visible = scoped.filter(
    (r) =>
      resourceKind(r) === kind &&
      (!favoritesOnly || props.preferences?.favorites?.includes(r.id)),
  );
  const categoryResources = all.data?.filter((r) => resourceKind(r) === kind);
  function changeKind(next: ResourceKind | "systems") {
    setChosenKind(next);
    history.replaceState(
      null,
      "",
      `#catalog?${params(filter)}&kind=${next}${favoritesOnly ? "&favorites=true" : ""}`,
    );
  }
  function change(key: keyof Filter, value: string) {
    setChosenKind(kind);
    setFilter((f) => ({ ...f, [key]: value }));
    const next = { ...filter, [key]: value };
    history.replaceState(
      null,
      "",
      `#catalog?${params(next)}&kind=${kind}${favoritesOnly ? "&favorites=true" : ""}`,
    );
  }
  async function exportData() {
    try {
      const payload = await api("/export");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `pl-ui-portal-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e);
    }
  }
  if (kind === "systems")
    return <SystemsCatalog actions={props} onView={changeKind} />;
  return (
    <>
      <div className="page-title">
        <div>
          <h1>Каталог ресурсов</h1>
          <p>
            {kind === "applications"
              ? "Приложения и рабочие сервисы"
              : "Серверы, виртуальные машины и оборудование"}
            {" · "}
            {resources.isPending ? "—" : visible.length}
            {" ресурсов"}
          </p>
        </div>
        <div className="actions">
          <Button onClick={() => setImporting(true)}>
            <Upload size={16} />
            {ru.import}
          </Button>
          <Button onClick={() => void exportData()}>
            <Download size={16} />
            {ru.eksport}
          </Button>
          <Button variant="default" onClick={() => props.onEdit()}>
            <Plus size={17} />
            {copy.addResource}
          </Button>
        </div>
      </div>
      <div
        className="catalog-view-switch"
        role="group"
        aria-label="Представление каталога"
      >
        {(["applications", "infrastructure", "systems"] as const).map(
          (view) => (
            <Button
              key={view}
              variant={kind === view ? "default" : "ghost"}
              aria-pressed={kind === view}
              onClick={() => changeKind(view)}
            >
              {view === "applications"
                ? "Приложения"
                : view === "systems"
                  ? "Системы"
                  : "Инфраструктура"}
              <span className="catalog-view-count">
                {view === "systems"
                  ? (systems.data?.length ?? "—")
                  : resources.isPending
                    ? "—"
                    : scoped.filter((r) => resourceKind(r) === view).length}
              </span>
            </Button>
          ),
        )}
      </div>
      <div className="catalog-layout">
        <aside className="catalog-nav">
          <button
            className={
              !filter.direction && !filter.collection && !favoritesOnly
                ? "selected"
                : ""
            }
            onClick={() => {
              setFavoritesOnly(false);
              setFilter((f) => ({ ...f, direction: "", collection: "" }));
              history.replaceState(
                null,
                "",
                `#catalog?${params({ ...filter, direction: "", collection: "" })}&kind=${kind}`,
              );
            }}
          >
            {kind === "applications" ? "Все приложения" : "Вся инфраструктура"}
            <span>{categoryResources?.length ?? "—"}</span>
          </button>
          <button
            className={favoritesOnly ? "selected" : ""}
            aria-pressed={favoritesOnly}
            onClick={() => {
              const next = !favoritesOnly;
              setFavoritesOnly(next);
              history.replaceState(
                null,
                "",
                `#catalog?${params(filter)}&kind=${kind}${next ? "&favorites=true" : ""}`,
              );
            }}
          >
            <span className="catalog-favorites-label">
              <Star size={16} />
              Избранное
            </span>
            <span>
              {categoryResources?.filter((r) =>
                props.preferences?.favorites?.includes(r.id),
              ).length ?? "—"}
            </span>
          </button>
          <h3>{ru.napravleniya}</h3>
          {dictionaries.data?.directions?.map((d) => (
            <button
              className={filter.direction === d ? "selected" : ""}
              key={d}
              onClick={() => change("direction", d)}
            >
              {d}
              <span>
                {categoryResources?.filter((r) => r.directions?.includes(d))
                  .length || 0}
              </span>
            </button>
          ))}
          <div className="collection-title">
            <h3>{ru.podborki}</h3>
            <Button
              variant="ghost"
              size="icon"
              aria-label={ru.dobavit_podborku}
              onClick={() => setCollection("new")}
            >
              <Plus size={15} />
            </Button>
          </div>
          {collections.data?.map((c) => (
            <div className="collection-nav" key={c.id}>
              <button
                className={filter.collection === c.id ? "selected" : ""}
                onClick={() =>
                  change("collection", filter.collection === c.id ? "" : c.id)
                }
              >
                {c.name}
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={ru.izmenit_podborku + c.name}
                onClick={() => setCollection(c)}
              >
                <SlidersHorizontal size={14} />
              </Button>
            </div>
          ))}
          {!collections.data?.length && (
            <p className="muted">
              {ru.obedinyayte_resursy_sistemy_ili_proekta}
            </p>
          )}
        </aside>
        <div className="catalog-main">
          <div className="filter-bar">
            <div className="input-icon catalog-filter-search">
              <Search size={17} />
              <input
                aria-label={ru.poisk_v_kataloge}
                placeholder="Название, IP, hostname или alias"
                value={filter.q}
                onChange={(e) => change("q", e.target.value)}
              />
            </div>
            <select
              className="catalog-filter-sort"
              aria-label={ru.sortirovka}
              value={filter.sort}
              onChange={(e) => change("sort", e.target.value)}
            >
              <option value="name">{ru.po_nazvaniyu}</option>
              <option value="updated">{ru.po_izmeneniyu}</option>
            </select>
            <select
              aria-label={ru.ploschadka}
              value={filter.site || ""}
              onChange={(e) => change("site", e.target.value)}
            >
              <option value="">{ru.vse_ploschadki}</option>
              {dictionaries.data?.sites?.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <select
              aria-label={ru.sreda}
              value={filter.environment || ""}
              onChange={(e) => change("environment", e.target.value)}
            >
              <option value="">{ru.vse_sredy}</option>
              {dictionaries.data?.environments?.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <input
              className="tag-filter"
              aria-label={ru.teg}
              placeholder={ru.teg}
              value={filter.tag || ""}
              onChange={(e) => change("tag", e.target.value)}
            />
            <select
              aria-label={ru.zhiznennyy_tsikl}
              value={filter.lifecycle}
              onChange={(e) => change("lifecycle", e.target.value)}
            >
              <option value="active">{ru.aktivnye}</option>
              <option value="archived">{ru.v_arhive}</option>
              <option value="all">{ru.vse_zapisi}</option>
            </select>
          </div>
          {!!error && <ErrorBox error={error} />}{" "}
          {resources.error ? (
            <ErrorBox
              error={resources.error}
              retry={() => void resources.refetch()}
            />
          ) : resources.isPending ? (
            <p className="loading">{copy.loading}</p>
          ) : visible.length ? (
            <div className="catalog-table-scroll">
              <div className="resource-list" role="table" aria-label="Ресурсы">
                <div className="catalog-table-header" role="row">
                  {[
                    "Ресурс",
                    "IP",
                    "Направление",
                    "Площадка",
                    "Среда",
                    "Действия",
                  ].map((label) => (
                    <div role="columnheader" key={label}>
                      {label}
                    </div>
                  ))}
                </div>
                {visible.map((r) => (
                  <ResourceRow key={r.id} resource={r} {...props} />
                ))}
              </div>
            </div>
          ) : (
            <Empty
              title={all.data?.length ? copy.noMatches : copy.emptyCatalog}
              detail={
                all.data?.length
                  ? copy.noMatchesDetail
                  : copy.emptyCatalogDetail
              }
              action={
                <Button
                  onClick={() =>
                    all.data?.length
                      ? (setFavoritesOnly(false),
                        setFilter({ q: "", lifecycle: "active", sort: "name" }),
                        history.replaceState(null, "", `#catalog?kind=${kind}`))
                      : props.onEdit()
                  }
                >
                  {all.data?.length ? copy.clearFilters : copy.addResource}
                </Button>
              }
            />
          )}
          <div className="list-footer">
            <span>
              Показано {visible.length} из {categoryResources?.length ?? "—"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCollection("new")}
            >
              <FolderPlus size={15} />
              {ru.sohranit_podborku}
            </Button>
          </div>
        </div>
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}{" "}
      {collection && (
        <CollectionEditor
          value={collection === "new" ? undefined : collection}
          initialFilter={filter}
          resources={all.data || []}
          onClose={() => setCollection(null)}
        />
      )}
    </>
  );
}
export { ResourceDetails } from "./ResourceDetails";
function CollectionEditor({
  value,
  initialFilter,
  resources,
  onClose,
}: {
  value?: Collection;
  initialFilter: Filter;
  resources: Resource[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Collection>(
    value || {
      mode: "manual",
      id: "",
      revision: 0,
      name: "",
      description: "",
      resource_ids: [],
      filter: {},
    },
  );
  const [dynamic, setDynamic] = useState(value?.mode === "filter");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(
        value ? `/collections/${value.id}` : "/collections",
        value ? "PUT" : "POST",
        {
          ...draft,
          mode: dynamic ? "filter" : "manual",
          resource_ids: dynamic ? [] : draft.resource_ids,
          filter: dynamic ? draft.filter : {},
        },
      );
      await refresh();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    try {
      await api(`/collections/${value!.id}`, "DELETE", undefined, {
        "If-Match": String(value!.revision),
      });
      await refresh();
      onClose();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Dialog
      helpTopic="collection-editor"
      title={value ? ru.redaktirovat_podborku : ru.novaya_podborka}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={ru.nazvanie}>
          <input
            required
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label={ru.opisanie}>
          <textarea
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
        </Field>
        <div className="segmented">
          <Button
            variant={!dynamic ? "default" : "ghost"}
            onClick={() => setDynamic(false)}
          >
            {ru.ruchnaya}
          </Button>
          <Button
            variant={dynamic ? "default" : "ghost"}
            onClick={() => {
              setDynamic(true);
              setDraft({
                ...draft,
                filter: value?.filter || {
                  q: initialFilter.q,
                  direction: initialFilter.direction,
                  site: initialFilter.site,
                  environment: initialFilter.environment,
                  tag: initialFilter.tag,
                },
              });
            }}
          >
            {ru.po_usloviyam}
          </Button>
        </div>
        {dynamic ? (
          <div className="form-grid">
            {[
              ["q", ru.poisk],
              ["direction", ru.napravlenie],
              ["site", ru.ploschadka],
              ["environment", ru.sreda],
              ["tag", ru.teg],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  value={draft.filter[key as keyof Filter] || ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      filter: { ...draft.filter, [key]: e.target.value },
                    })
                  }
                />
              </Field>
            ))}
          </div>
        ) : (
          <div className="check-list">
            {resources.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={draft.resource_ids.includes(r.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      resource_ids: e.target.checked
                        ? [...draft.resource_ids, r.id]
                        : draft.resource_ids.filter((id) => id !== r.id),
                    })
                  }
                />
                {r.name}
              </label>
            ))}
          </div>
        )}
        {!!error && <ErrorBox error={error} />}
        <div className="dialog-footer">
          {value && (
            <Button variant="destructive" onClick={() => void remove()}>
              {ru.udalit_podborku}
            </Button>
          )}
          <Button type="submit" variant="default" disabled={busy}>
            {ru.sohranit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function ImportDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function run(apply = false) {
    setError(undefined);
    setBusy(true);
    try {
      if (apply) {
        await api("/import/apply", "POST", { token: preview!.token });
        await refresh();
        onClose();
      } else
        setPreview(
          await api<ImportPreview>("/import/preview", "POST", JSON.parse(text)),
        );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      helpTopic="import"
      title={ru.import_kataloga}
      description={
        ru.json_schema_version_1_snachala_proverte_plan_sovpadayuschie_id
      }
      onClose={onClose}
      wide
    >
      <Field label={ru.fayl_json}>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void file.text().then((v) => {
                setText(v);
                setPreview(undefined);
              });
          }}
        />
      </Field>
      <Field label={ru.soderzhimoe_importa}>
        <textarea
          rows={7}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(undefined);
          }}
        />
      </Field>
      {preview && (
        <Panel title={ru.predvaritelnyy_prosmotr}>
          <p className="muted">
            {ru.plan_deystvitelen_do + " "}
            {date(preview.expires_at)}
          </p>
          {preview.changes.map((c, i) => (
            <div className="simple-row" key={i}>
              <strong>{c.name}</strong>
              <Badge value={c.action} />
              <span>{c.reason}</span>
            </div>
          ))}
          {!!preview.conflicts?.length && (
            <ErrorBox
              error={
                new Error(ru.konflikty + JSON.stringify(preview.conflicts))
              }
            />
          )}
        </Panel>
      )}
      {!!error && <ErrorBox error={error} />}
      <div className="dialog-footer">
        <Button disabled={!text || busy} onClick={() => void run()}>
          {ru.proverit_fayl}
        </Button>
        {preview && (
          <Button
            variant="default"
            disabled={busy || !!preview.conflicts?.length}
            onClick={() => void run(true)}
          >
            {ru.primenit + " "}
            {preview.changes.length}
            {" " + ru.izmeneniy}
            <ArrowRight size={15} />
          </Button>
        )}
      </div>
    </Dialog>
  );
}
