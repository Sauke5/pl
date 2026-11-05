import { useEffect, useState } from "react";
import { ListChecks } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BoardTask } from "./task-card";
type PreviewItem = BoardTask["checklistPreview"][number];
export function CardChecklistGroup({
  group,
  title,
  pendingItem,
  disabled,
  onToggle,
  onOpen,
}: {
  group: { total: number; done: number; preview: PreviewItem[] };
  title?: string;
  pendingItem: PreviewItem | null;
  disabled: boolean;
  onToggle: (item: PreviewItem) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation("doska");
  const preview = group.preview;
  const progress = group;
  const currentItem = preview.find((item) => item.id === pendingItem?.id);
  const done =
    progress.done +
    (pendingItem && currentItem && currentItem.done === pendingItem.done
      ? pendingItem.done
        ? -1
        : 1
      : 0);
  const allDone = progress.total > 0 && done === progress.total;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!allDone) setExpanded(false);
  }, [allDone]);
  const showItems = !allDone || expanded;
  return (
    <>
      {(progress.total > 0 || title) && (
        <div className="doska-card-checklist">
          {title && (
            <strong className="doska-card-checklist-title">{title}</strong>
          )}
          <div
            className={`doska-card-progress${allDone ? " is-complete" : ""}`}
            aria-label={t("boardChecklistProgress", {
              done,
              total: progress.total,
            })}
          >
            <ListChecks size={14} />
            <span>
              {done}/{progress.total}
            </span>
            <progress value={done} max={progress.total} />
          </div>
          {allDone && (
            <button
              type="button"
              className="doska-card-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {t(expanded ? "checklistCollapse" : "checklistExpand")}
            </button>
          )}
          {showItems &&
            preview.map((item) => (
              <div key={item.id} className="doska-card-check-row">
                <label
                  className={`doska-card-check${(pendingItem?.id === item.id ? !pendingItem.done : item.done) ? " is-done" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={
                      pendingItem?.id === item.id
                        ? !pendingItem.done
                        : item.done
                    }
                    disabled={disabled}
                    onChange={() => {
                      onToggle(item);
                    }}
                  />
                  <span>{item.text}</span>
                </label>
              </div>
            ))}
          {showItems && progress.total > preview.length && (
            <button className="doska-card-more" onClick={onOpen}>
              {t("boardChecklistMore", {
                count: progress.total - preview.length,
              })}
            </button>
          )}
        </div>
      )}
    </>
  );
}
