import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { api } from "./api";
import { startPages, type StartPage } from "./start-page";
import "./personal-settings.css";
export function DoskaPersonalSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("doska");
  const ref = useRef<HTMLDialogElement>(null);
  const cache = useQueryClient();
  const preferences = useQuery({
    queryKey: ["doska", "preferences"],
    queryFn: () => api.preferences(),
    retry: false,
  });
  const save = useMutation({
    onMutate: () => cache.cancelQueries({ queryKey: ["doska", "preferences"] }),
    mutationFn: (startPage: StartPage) => api.updatePreferences({ startPage }),
    onSuccess: (data) => cache.setQueryData(["doska", "preferences"], data),
  });
  useEffect(() => {
    const previous = document.activeElement,
      dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="doska-dialog pl-ui-native-dialog doska-personal-settings"
      aria-labelledby="personal-settings-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <header>
        <h2 id="personal-settings-heading">{t("personalSettings")}</h2>
        <button
          className="doska-icon"
          onClick={onClose}
          aria-label={t("close")}
        >
          <X size={18} />
        </button>
      </header>
      {preferences.isError ? (
        <div role="alert">
          {t("personalSettingsLoadError")}{" "}
          <button
            className="pl-ui-button pl-ui-button-secondary"
            onClick={() => void preferences.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      ) : preferences.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <label>
          {t("startPageLabel")}
          <select
            className="pl-ui-select"
            value={save.isPending ? save.variables : preferences.data.startPage}
            disabled={save.isPending}
            onChange={(event) => save.mutate(event.target.value as StartPage)}
          >
            {Object.entries(startPages).map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
      )}
      {save.isPending && <p role="status">{t("saving")}</p>}
      {save.isError && (
        <p role="alert">
          {t("saveError")}{" "}
          <button
            className="pl-ui-button pl-ui-button-secondary"
            onClick={() => save.mutate(save.variables)}
          >
            {t("retry")}
          </button>
        </p>
      )}
    </dialog>
  );
}
