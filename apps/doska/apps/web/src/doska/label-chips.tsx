import { useTranslation } from "react-i18next";
import "./task-labels.css";
export const labelColors = {
  blue: "#5d9edc",
  cyan: "#43b9c4",
  green: "#55aa7b",
  yellow: "#c1a036",
  orange: "#d78a48",
  red: "#d76b75",
  pink: "#c879b0",
  purple: "#a183ce",
};
export function labelColor(value: string) {
  return (
    labelColors[value as keyof typeof labelColors] ??
    (/^#[0-9a-f]{6}$/i.test(value) ? value : "#8293a4")
  );
}

export function DoskaLabelChips({
  labels,
  onRemove,
}: {
  labels: { name: string; color: string }[];
  onRemove?: (name: string) => void;
}) {
  const { t } = useTranslation("doska");
  if (!labels.length) return null;
  return (
    <div className="doska-label-chips">
      {labels.map((item) => (
        <span
          key={item.name}
          className="doska-label-chip"
          style={{ borderColor: labelColor(item.color) }}
        >
          <i aria-hidden style={{ backgroundColor: labelColor(item.color) }} />
          {item.name}
          {onRemove && (
            <button
              type="button"
              aria-label={t("taskLabelRemove", { name: item.name })}
              onClick={() => onRemove(item.name)}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
