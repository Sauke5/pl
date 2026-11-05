import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { DoskaLabelChips, labelColors as colors } from "./label-chips";
export { labelColor } from "./label-chips";
import "./task-labels.css";
export type TaskLabel = { name: string; color: string };
export function DoskaTaskLabels({
  projectId,
  value,
  editable,
  onChange,
  onDirtyChange,
}: {
  projectId: string;
  value: TaskLabel[];
  editable: boolean;
  onChange: (value: TaskLabel[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation("doska");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [color, setColor] = useState("blue");
  useEffect(() => {
    onDirtyChange?.(Boolean(name.trim()));
  }, [name, onDirtyChange]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(name.trim()), 200);
    return () => clearTimeout(timer);
  }, [name]);
  const suggestions = useQuery({
    queryKey: ["doska", "labels", projectId, query],
    queryFn: () =>
      api.listProjectLabels(projectId, { q: query || undefined, limit: 20 }),
    enabled: editable && Boolean(query),
  });
  const available = (suggestions.data ?? [])
    .filter((item) => !value.some((current) => current.name === item.name))
    .slice(0, 8);
  const valid =
    Boolean(name.trim()) &&
    value.length < 20 &&
    !value.some((item) => item.name === name.trim());
  const add = (item: TaskLabel) => {
    if (
      !editable ||
      value.length >= 20 ||
      value.some((current) => current.name === item.name)
    )
      return;
    onChange([...value, item]);
    setName("");
  };
  if (!editable && !value.length) return null;
  return (
    <section className="doska-task-labels" aria-label={t("taskLabels")}>
      <span className="doska-meta">{t("taskLabels")}</span>
      <DoskaLabelChips
        labels={value}
        onRemove={
          editable
            ? (name) => onChange(value.filter((item) => item.name !== name))
            : undefined
        }
      />
      {editable && (
        <>
          <div className="doska-label-add">
            <input
              aria-label={t("taskLabelName")}
              placeholder={t("taskLabelName")}
              maxLength={100}
              value={name}
              disabled={value.length >= 20}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (valid)
                    add(
                      available.find((item) => item.name === name.trim()) ?? {
                        name: name.trim(),
                        color,
                      },
                    );
                }
              }}
            />
            <select
              aria-label={t("taskLabelColor")}
              value={color}
              onChange={(event) => setColor(event.target.value)}
            >
              {Object.keys(colors).map((color) => (
                <option key={color} value={color}>
                  {t(`cardColor_${color}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!valid}
              onClick={() =>
                add(
                  available.find((item) => item.name === name.trim()) ?? {
                    name: name.trim(),
                    color,
                  },
                )
              }
            >
              {t("taskLabelAdd")}
            </button>
          </div>
          {name.trim() && (
            <div className="doska-label-suggestions">
              {available.map((item) => (
                <button type="button" key={item.name} onClick={() => add(item)}>
                  {item.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
