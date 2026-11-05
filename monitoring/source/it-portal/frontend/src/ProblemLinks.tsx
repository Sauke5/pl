import { useEffect, useState } from "react";
import { api, APIError, refresh, useAPI } from "./api";
import type { Problem, Resource } from "./types";
import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { ErrorBox, Field } from "./components/common";
import { ru } from "./ru";
export type ProblemLinksState = {
  revision: number;
  mode: "auto" | "manual" | "disabled";
  resource_ids: string[];
  reason: string;
  candidates: { id: string; name: string; reason: string }[];
  rule?: {
    id: string;
    label: string;
    value: string;
    job: string;
    resource_ids: string[];
  };
};
export function ProblemLinks({
  problem,
  resources,
  onClose,
}: {
  problem: Problem;
  resources: Resource[];
  onClose: () => void;
}) {
  const data = useAPI<ProblemLinksState>(`/problems/${problem.id}/links`);
  const [draft, setDraft] = useState<ProblemLinksState>();
  const [query, setQuery] = useState("");
  const [targetScope, setTargetScope] = useState(false);
  const [removeRule, setRemoveRule] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const labels = [
    "instance",
    "target",
    "host",
    "hostname",
    "node",
    "nodename",
    "server",
    "veeam_server",
    "device",
  ].filter((key) => problem.labels[key]);
  const [label, setLabel] = useState(labels[0] || "");
  useEffect(() => {
    if (data.data && !draft) setDraft(data.data);
  }, [data.data, draft]);
  async function reload() {
    const next = await data.refetch();
    if (next.data) {
      setDraft(next.data);
      setError(undefined);
    }
  }
  async function save() {
    if (!draft) return;
    if (draft.mode === "manual" && !draft.resource_ids.length) {
      setError(new Error(ru.links_select_resource));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(`/problems/${problem.id}/links`, "PUT", {
        revision: draft.revision,
        mode: draft.mode,
        resource_ids: draft.mode === "manual" ? draft.resource_ids : [],
        scope: draft.mode === "manual" && targetScope ? "target" : "problem",
        ...(draft.mode === "manual" && targetScope
          ? {
              label,
              value: problem.labels[label],
              job: problem.labels.job || "",
            }
          : {}),
        ...(removeRule && draft.rule ? { remove_rule_id: draft.rule.id } : {}),
      });
      await refresh();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={ru.links_title} onClose={onClose}>
      {data.error ? (
        <ErrorBox error={data.error} retry={() => void reload()} />
      ) : !draft ? (
        <p className="muted">{ru.zagruzka}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="muted">{problem.title}</p>
          <Field label={ru.links_mode}>
            <select
              value={draft.mode}
              disabled={busy}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  mode: event.target.value as ProblemLinksState["mode"],
                })
              }
            >
              <option value="auto">{ru.links_auto}</option>
              <option value="manual">{ru.links_manual}</option>
              <option value="disabled">{ru.links_disabled}</option>
            </select>
          </Field>
          <p className="muted">
            {draft.mode === "auto"
              ? ru.links_auto_hint
              : draft.mode === "disabled"
                ? ru.links_disabled_hint
                : ru.links_manual_hint}
          </p>
          {draft.reason && <p className="notice">{draft.reason}</p>}
          {!draft.candidates.length && draft.mode === "auto" && (
            <p className="muted">{ru.links_no_candidates}</p>
          )}
          {draft.candidates.length > 0 && (
            <p className="muted">
              {ru.links_candidates}:{" "}
              {draft.candidates.map((candidate) => candidate.name).join(", ")}
            </p>
          )}
          {draft.mode === "manual" && (
            <>
              <Field label={ru.links_find_resource}>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </Field>
              <div
                className="resource-link-options"
                role="group"
                aria-label={ru.links_resources}
              >
                {resources
                  .filter(
                    (resource) =>
                      draft.resource_ids.includes(resource.id) ||
                      `${resource.name} ${resource.url}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  )
                  .map((resource) => (
                    <label className="checkbox-label" key={resource.id}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={draft.resource_ids.includes(resource.id)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            resource_ids: event.target.checked
                              ? [...draft.resource_ids, resource.id]
                              : draft.resource_ids.filter(
                                  (id) => id !== resource.id,
                                ),
                          })
                        }
                      />
                      <span>
                        {resource.name}
                        <small>{resource.hostname || resource.ip}</small>
                      </span>
                    </label>
                  ))}
              </div>
              {labels.length > 0 && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={targetScope}
                    onChange={(event) => setTargetScope(event.target.checked)}
                  />
                  {ru.links_target_scope}
                </label>
              )}
              {targetScope && (
                <Field label={ru.links_target}>
                  <select
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  >
                    {labels.map((key) => (
                      <option key={key} value={key}>
                        {key}: {problem.labels[key]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          )}
          {draft.rule && (
            <div className="notice">
              <p>
                {ru.links_active_rule}: {draft.rule.label} = {draft.rule.value}
                {draft.rule.job ? ` · job: ${draft.rule.job}` : ""}
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={removeRule}
                  onChange={(event) => setRemoveRule(event.target.checked)}
                />
                {ru.links_remove_rule}
              </label>
              <small>{ru.links_remove_rule_hint}</small>
            </div>
          )}
          {!!error && <ErrorBox error={error} />}
          {error instanceof APIError && error.status === 409 && (
            <Button onClick={() => void reload()}>{ru.links_reload}</Button>
          )}
          <div className="dialog-footer">
            <Button type="submit" variant="default" disabled={busy}>
              {ru.sohranit}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
