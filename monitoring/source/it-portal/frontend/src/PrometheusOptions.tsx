import { useEffect, useId, useState } from "react";
import { useAPI } from "./api";
import { Field } from "./components/common";
import { ru } from "./ru";
type Options = {
  jobs: string[];
  labels: string[];
  values: string[];
  target_count: number;
  truncated: boolean;
  observed_at: string;
};
export function PrometheusOptions({
  integrationID,
  config,
  onChange,
}: {
  integrationID?: string;
  config: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const id = useId();
  const job = config.include_job?.includes(",") ? "" : config.include_job || "";
  const raw = new URLSearchParams({
    job,
    label: config.match_label || "",
  }).toString();
  const [query, setQuery] = useState(raw);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(raw), 300);
    return () => clearTimeout(timer);
  }, [raw]);
  const options = useAPI<Options>(
    `/integrations/${integrationID}/prometheus/options?${query}`,
    !!integrationID,
  );
  const choices: Record<string, string[]> = {
    include_job: options.data?.jobs || [],
    exclude_job: options.data?.jobs || [],
    match_label: options.data?.labels || [],
    match_value: options.data?.values || [],
    instance_label: options.data?.labels || [],
  };
  return (
    <>
      <div className="form-grid">
        {[
          ["include_job", ru.include_jobs],
          ["exclude_job", ru.exclude_jobs],
          ["match_label", ru.match_label],
          ["match_value", ru.match_value],
          ["instance_label", ru.instance_label],
        ].map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              list={`${id}-${key}`}
              value={config[key] || ""}
              onChange={(event) =>
                onChange({ ...config, [key]: event.target.value })
              }
            />
            <datalist id={`${id}-${key}`}>
              {[
                ...new Set([
                  ...(config[key] ? [config[key]] : []),
                  ...choices[key],
                ]),
              ].map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </Field>
        ))}
      </div>
      <p className="muted">
        {!integrationID
          ? ru.prom_options_save_first
          : options.error
            ? ru.prom_options_unavailable
            : options.data
              ? `${ru.prom_options_available} ${options.data.target_count}${options.data.truncated ? ` · ${ru.prom_options_truncated}` : ""}`
              : ru.zagruzka}
      </p>
      <p className="muted">{ru.prom_options_manual}</p>
    </>
  );
}
