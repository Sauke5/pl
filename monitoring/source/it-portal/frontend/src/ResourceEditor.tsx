import { ru } from "./ru";
import { useState } from "react";
import { Plus, Trash2, Sparkles } from "lucide-react";
import { api, useAPI, refresh } from "./api";
import type { Resource, Dictionaries, Endpoint, Job } from "./types";
import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Field, ErrorBox, MultiInput } from "./components/common";
import { copy } from "./copy";
import { ResourceIconPicker } from "./components/ResourceIconPicker";
import { Badge, ResourceIcon } from "./components/common";
export function emptyResource(): Resource {
  return {
    id: "",
    revision: 0,
    name: "",
    description: "",
    url: "",
    type: "",
    endpoints: [],
    links: [],
    ip: "",
    hostname: "",
    aliases: [],
    directions: [],
    site: "",
    environment: "",
    tags: [],
    relations: [],
    source: "manual",
    external_ids: [],
    check: { kind: "", target: "", interval_seconds: 0 },
    operations: [],
    executor_target: "",
    lifecycle: "active",
    created_at: "",
    updated_at: "",
  };
}
function EndpointEditor({
  value,
  onChange,
}: {
  value: Endpoint[];
  onChange: (v: Endpoint[]) => void;
}) {
  return (
    <div className="repeat-fields">
      {(value || []).map((e, i) => (
        <div className="inline-form" key={i}>
          <input
            aria-label={ru.nazvanie_ssylki + (i + 1)}
            value={e.name}
            placeholder={ru.nazvanie}
            onChange={(event) =>
              onChange(
                value.map((v, n) =>
                  n === i ? { ...v, name: event.target.value } : v,
                ),
              )
            }
          />
          <input
            aria-label={ru.adres_ssylki + (i + 1)}
            value={e.url}
            placeholder="https://…"
            onChange={(event) =>
              onChange(
                value.map((v, n) =>
                  n === i ? { ...v, url: event.target.value } : v,
                ),
              )
            }
          />
          <Button
            size="icon"
            aria-label={ru.udalit_ssylku + (i + 1)}
            onClick={() => onChange(value.filter((_, n) => n !== i))}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        onClick={() => onChange([...value, { name: "", url: "" }])}
      >
        <Plus size={14} />
        {ru.dobavit_ssylku}
      </Button>
    </div>
  );
}
export default function ResourceEditor({
  resource,
  onClose,
}: {
  resource?: Resource;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Resource>(() =>
    resource ? structuredClone(resource) : emptyResource(),
  );
  const isHost = [
    "сервер",
    "устройство",
    "сетевое устройство",
    "хранилище",
    "виртуальная машина",
    "server",
    "host",
    "network",
    "storage",
    "virtual machine",
  ].includes(draft.type.trim().toLowerCase());
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [enrichID, setEnrichID] = useState("");
  const [enrichBusy, setEnrichBusy] = useState(false);
  const dictionaries = useAPI<Dictionaries>("/dictionaries");
  const relationTypes = dictionaries.data?.relation_types ?? [
    "Размещено на",
    "Использует БД",
    "Зависит от",
    "Резервируется на",
  ];
  const all = useAPI<Resource[]>("/resources");
  const enrich = useAPI<Job>(`/jobs/${enrichID}`, !!enrichID);
  function set<K extends keyof Resource>(key: K, value: Resource[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }
  async function save() {
    if (
      isHost &&
      !draft.url.trim() &&
      !draft.hostname.trim() &&
      !draft.ip.trim()
    ) {
      setError(
        new Error(
          "Укажите hostname или IP устройства. Веб-адрес необязателен.",
        ),
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const payload: Partial<Resource> = { ...draft };
      delete payload.created_at;
      delete payload.updated_at;
      if (!resource) {
        delete payload.id;
        delete payload.revision;
      }
      await api(
        resource ? `/resources/${resource.id}` : "/resources",
        resource ? "PUT" : "POST",
        payload,
      );
      await refresh();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function suggest() {
    setEnrichBusy(true);
    try {
      const job = await api<Job>("/jobs", "POST", {
        kind: "enrich",
        resource_id: resource?.id || "",
        parameters: { target: draft.url },
        idempotency_key: crypto.randomUUID(),
      });
      setEnrichID(job.id);
    } catch (e) {
      setError(e);
    } finally {
      setEnrichBusy(false);
    }
  }
  const suggestions = enrich.data?.result?.suggestions as
    | {
        name?: string;
        type?: string;
        icon?: string;
        check?: Resource["check"];
      }
    | undefined;
  const observations = enrich.data?.result?.observations as
    Record<string, unknown> | undefined;
  const duplicates = enrich.data?.result?.possible_duplicates as
    | {
        id: string;
        name: string;
      }[]
    | undefined;
  return (
    <Dialog
      wide
      helpTopic={resource ? "resource-edit" : "resource-create"}
      title={resource ? ru.redaktirovanie_resursa : copy.addResource}
      description={
        isHost
          ? "Укажите название и hostname или IP устройства. Веб-интерфейс можно добавить отдельно."
          : ru.resurs_budet_dostupen_vsey_it_gruppe_dostatochno_nazvaniya_i_o
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-grid">
          <Field label={ru.nazvanie_2}>
            <input
              required
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              autoFocus
            />
          </Field>
          <Field
            label={isHost ? "Веб-интерфейс (необязательно)" : ru.osnovnoy_adres}
          >
            <input
              required={!isHost}
              type="url"
              value={draft.url}
              placeholder="https://service.example.ru"
              onChange={(e) => set("url", e.target.value)}
            />
          </Field>
        </div>
        <ResourceIconPicker
          value={draft.icon || "auto"}
          identity={{ name: draft.name, type: draft.type, url: draft.url }}
          onChange={(value) => set("icon", value)}
        />
        {(!isHost || !!draft.url.trim()) && (
          <div className="enrichment">
            <Button
              size="sm"
              disabled={!draft.url || enrichBusy}
              onClick={() => void suggest()}
            >
              <Sparkles size={15} />
              {ru.predlozhit_dannye_po_adresu}
            </Button>
            <small>
              {ru.zapros_vypolnyaetsya_otdelno_i_ne_blokiruet_sohranenie}
            </small>
            {enrichID && (
              <div className="notice">
                <div className="simple-row">
                  <strong>{ru.dannye_po_adresu}</strong>
                  <Badge value={enrich.data?.status || "queued"} />
                </div>
                {enrich.data?.status === "succeeded" ? (
                  <>
                    <p className="muted">
                      {
                        ru.avtomaticheskie_predlozheniya_primenyayutsya_tolko_vybrannye_v
                      }
                    </p>
                    {suggestions && (
                      <div className="suggestion-list">
                        <div className="simple-row">
                          <ResourceIcon type={suggestions.type} />
                          <span>
                            {suggestions.name || ru.nazvanie_ne_polucheno}
                          </span>
                          {suggestions.name && (
                            <Button
                              size="sm"
                              onClick={() => set("name", suggestions.name!)}
                            >
                              {ru.primenit_nazvanie}
                            </Button>
                          )}
                        </div>
                        {suggestions.type && (
                          <div className="simple-row">
                            <span>
                              {ru.tip_2 + " "}
                              {suggestions.type}
                            </span>
                            <Button
                              size="sm"
                              onClick={() => set("type", suggestions.type!)}
                            >
                              {ru.primenit_tip}
                            </Button>
                          </div>
                        )}
                        {suggestions.check && (
                          <div className="simple-row">
                            <span>
                              {ru.proverka_2 + " "}
                              {suggestions.check.kind.toUpperCase()} ·{" "}
                              {suggestions.check.target}
                            </span>
                            <Button
                              size="sm"
                              onClick={() => set("check", suggestions.check!)}
                            >
                              {ru.primenit_proverku}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                    {!!duplicates?.length && (
                      <div className="danger-notice">
                        <strong>{ru.vozmozhnye_dublikaty}</strong>
                        {duplicates.map((r) => (
                          <p key={r.id}>{r.name}</p>
                        ))}
                      </div>
                    )}
                    <details>
                      <summary>{ru.nablyudeniya_istochnika}</summary>
                      <pre>{JSON.stringify(observations, null, 2)}</pre>
                    </details>
                    <p className="muted">
                      {
                        ru.http_otvet_ne_podtverzhdaet_rabotosposobnost_prilozheniya
                      }
                    </p>
                  </>
                ) : enrich.data?.error ? (
                  <ErrorBox error={new Error(enrich.data.error)} />
                ) : enrich.error ? (
                  <ErrorBox error={enrich.error} />
                ) : (
                  <p>
                    {
                      ru.poluchaem_svedeniya_mozhno_sohranit_resurs_ne_dozhidayas_rezul
                    }
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        <Field label={ru.opisanie}>
          <textarea
            rows={2}
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <div className="form-grid three">
          <Field label={ru.tip}>
            <input
              list="resource-types"
              value={draft.type}
              onChange={(e) => set("type", e.target.value)}
            />
            <datalist id="resource-types">
              {dictionaries.data?.types?.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </datalist>
          </Field>
          <Field label={ru.ploschadka}>
            <input
              list="resource-sites"
              value={draft.site}
              onChange={(e) => set("site", e.target.value)}
            />
            <datalist id="resource-sites">
              {dictionaries.data?.sites?.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </datalist>
          </Field>
          <Field label={ru.sreda}>
            <input
              list="resource-envs"
              value={draft.environment}
              onChange={(e) => set("environment", e.target.value)}
            />
            <datalist id="resource-envs">
              {dictionaries.data?.environments?.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </datalist>
          </Field>
        </div>
        <div className="form-grid">
          <Field label={ru.napravleniya_2}>
            <MultiInput
              value={draft.directions}
              onChange={(v) => set("directions", v)}
            />
          </Field>
          <Field label={ru.tegi}>
            <MultiInput value={draft.tags} onChange={(v) => set("tags", v)} />
          </Field>
          <Field label="IP">
            <input
              value={draft.ip}
              onChange={(e) => set("ip", e.target.value)}
            />
          </Field>
          <Field label="Hostname">
            <input
              value={draft.hostname}
              onChange={(e) => set("hostname", e.target.value)}
            />
          </Field>
        </div>
        <Field label={ru.alternativnye_nazvaniya}>
          <MultiInput
            value={draft.aliases}
            onChange={(v) => set("aliases", v)}
          />
        </Field>
        <details className="form-section">
          <summary>{ru.endpoints_dokumentatsiya_i_svyazi}</summary>
          <h4>{ru.dopolnitelnye_tochki_vhoda}</h4>
          <EndpointEditor
            value={draft.endpoints || []}
            onChange={(v) => set("endpoints", v)}
          />
          <h4>{ru.dokumentatsiya_i_diagnostika}</h4>
          <EndpointEditor
            value={draft.links || []}
            onChange={(v) => set("links", v)}
          />
          <h4>{ru.svyazannye_resursy}</h4>
          {(draft.relations || []).map((rel, i) => (
            <div className="inline-form" key={i}>
              <select
                aria-label={ru.svyazannyy_resurs}
                value={rel.resource_id}
                onChange={(e) =>
                  set(
                    "relations",
                    draft.relations.map((r, n) =>
                      n === i ? { ...r, resource_id: e.target.value } : r,
                    ),
                  )
                }
              >
                <option value="">{ru.vyberite_resurs}</option>
                {all.data
                  ?.filter((r) => r.id !== draft.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
              <input
                list="resource-relation-types"
                placeholder={ru.harakter_svyazi}
                aria-label={ru.harakter_svyazi}
                value={rel.label}
                onChange={(e) =>
                  set(
                    "relations",
                    draft.relations.map((r, n) =>
                      n === i ? { ...r, label: e.target.value } : r,
                    ),
                  )
                }
              />
              <Button
                size="icon"
                aria-label={ru.udalit_svyaz}
                onClick={() =>
                  set(
                    "relations",
                    draft.relations.filter((_, n) => n !== i),
                  )
                }
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
          <datalist id="resource-relation-types">
            {relationTypes.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
          <Button
            size="sm"
            onClick={() =>
              set("relations", [
                ...draft.relations,
                { resource_id: "", label: "" },
              ])
            }
          >
            {ru.dobavit_svyaz}
          </Button>
        </details>
        <details className="form-section">
          <summary>{ru.proverki_i_razreshyonnye_operatsii}</summary>
          <div className="form-grid three">
            <Field label={ru.sposob_proverki}>
              <select
                value={draft.check?.kind || ""}
                onChange={(e) =>
                  set("check", { ...draft.check, kind: e.target.value })
                }
              >
                <option value="">{ru.ne_nastroena}</option>
                {["dns", "tcp", "http", "tls"].map((v) => (
                  <option key={v} value={v}>
                    {v.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={ru.naznachenie_proverki}>
              <input
                value={draft.check?.target || ""}
                onChange={(e) =>
                  set("check", { ...draft.check, target: e.target.value })
                }
              />
            </Field>
            <Field label={ru.interval_sekund_0_vruchnuyu}>
              <input
                type="number"
                min={0}
                value={draft.check?.interval_seconds || 0}
                onChange={(e) =>
                  set("check", {
                    ...draft.check,
                    interval_seconds: Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>
          <div className="checkbox-row">
            {[
              ["check", ru.zapusk_proverki],
              ["report", ru.generatsiya_otchyota],
              ["restart", ru.perezapusk_konteynera],
            ].map(([v, l]) => (
              <label key={v}>
                <input
                  type="checkbox"
                  checked={draft.operations?.includes(v) || false}
                  onChange={(e) =>
                    set(
                      "operations",
                      e.target.checked
                        ? [...draft.operations, v]
                        : draft.operations.filter((x) => x !== v),
                    )
                  }
                />
                {l}
              </label>
            ))}
          </div>
          {draft.operations?.includes("restart") && (
            <Field
              label={ru.tochnaya_tsel_executor}
              hint={
                ru.razreshenie_takzhe_proveryaetsya_na_storone_executor_obnaruzhe
              }
            >
              <input
                value={draft.executor_target}
                onChange={(e) => set("executor_target", e.target.value)}
                placeholder={ru.razreshyonnoe_imya_konteynera}
              />
            </Field>
          )}
        </details>
        <details className="form-section">
          <summary>{ru.proishozhdenie_i_zhiznennyy_tsikl}</summary>
          <div className="form-grid">
            <Field label={ru.istochnik}>
              <input value={draft.source} readOnly />
            </Field>
            <Field label={ru.zhiznennyy_tsikl}>
              <select
                value={draft.lifecycle}
                onChange={(e) => set("lifecycle", e.target.value)}
              >
                <option value="active">{ru.aktiven}</option>
                <option value="archived">{ru.v_arhive}</option>
              </select>
            </Field>
          </div>
          <Field label={ru.vneshnie_identifikatory}>
            <input value={(draft.external_ids || []).join(", ")} readOnly />
          </Field>
        </details>
        <details className="form-section employee-metadata-fields">
          <summary>Подписи для сотрудника</summary>
          <p>
            Эти поля видны только после публикации ресурса в настройках board.
            Основное техническое описание сотруднику не передаётся.
          </p>
          {(["display_name", "description", "category"] as const).map((key) => (
            <Field
              key={key}
              label={
                {
                  display_name: "Понятное название",
                  description: "Описание для сотрудника",
                  category: "Категория сервиса",
                }[key]
              }
            >
              <input
                maxLength={
                  key === "description" ? 500 : key === "category" ? 80 : 160
                }
                value={draft.employee?.[key] || ""}
                onChange={(e) =>
                  set("employee", {
                    ...{
                      display_name: "",
                      description: "",
                      category: "",
                      icon: "app" as const,
                      support: false,
                    },
                    ...draft.employee,
                    [key]: e.target.value,
                  })
                }
              />
            </Field>
          ))}
          <Field label="Иконка сервиса">
            <select
              value={draft.employee?.icon || "app"}
              onChange={(e) =>
                set("employee", {
                  ...{
                    display_name: "",
                    description: "",
                    category: "",
                    support: false,
                  },
                  ...draft.employee,
                  icon: e.target.value as NonNullable<
                    Resource["employee"]
                  >["icon"],
                })
              }
            >
              <option value="app">Приложение</option>
              <option value="book">База знаний</option>
              <option value="folder">Файлы</option>
              <option value="support">Поддержка</option>
            </select>
          </Field>
          <label>
            <input
              type="checkbox"
              checked={draft.employee?.support || false}
              onChange={(e) =>
                set("employee", {
                  ...{
                    display_name: "",
                    description: "",
                    category: "",
                    icon: "app" as const,
                  },
                  ...draft.employee,
                  support: e.target.checked,
                })
              }
            />{" "}
            Использовать как сервис поддержки
          </label>
        </details>
        {!!error && <ErrorBox error={error} />}
        <div className="dialog-footer">
          <Button onClick={onClose}>{copy.cancel}</Button>
          <Button variant="default" type="submit" disabled={busy}>
            {busy ? ru.sohranyaem : copy.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
