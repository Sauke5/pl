import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, type Project } from "./api";
import { DoskaProjectFieldsSettings } from "./project-fields-settings";

export function DoskaProjectSettings({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { t } = useTranslation("doska");
  const cache = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [revision, setRevision] = useState(project.revision);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [visibility, setVisibility] = useState<"department" | "private">(
    project.visibility === "private" ? "private" : "department",
  );
  const [confirmVisibility, setConfirmVisibility] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const save = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, {
        expectedRevision: revision,
        name: name.trim(),
        description,
        visibility,
      }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["doska"] });
      onClose();
    },
  });
  return (
    <dialog
      ref={dialog}
      className="doska-dialog"
      aria-labelledby="project-settings-heading"
      onCancel={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (visibility !== project.visibility && !confirmVisibility)
            setConfirmVisibility(true);
          else save.mutate();
        }}
      >
        <h2 id="project-settings-heading">{t("projectSettings")}</h2>
        <fieldset
          className="doska-task-fields"
          disabled={save.isPending || Boolean(project.archivedAt)}
        >
          <label className="doska-field">
            {t("projectName")}
            <input
              value={name}
              maxLength={200}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="doska-field">
            {t("description")}
            <textarea
              value={description}
              rows={5}
              maxLength={20000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="doska-field">
            {t("visibility")}
            <select
              value={visibility}
              onChange={(e) => {
                setVisibility(e.target.value as "department" | "private");
                setConfirmVisibility(false);
              }}
            >
              <option value="department">{t("department")}</option>
              <option value="private">{t("private")}</option>
            </select>
          </label>
        </fieldset>
        {confirmVisibility && (
          <p className="doska-notice" role="alert">
            {t(
              visibility === "department"
                ? "confirmOpenProject"
                : "confirmPrivateProject",
            )}
          </p>
        )}
        {save.isError && (
          <p className="doska-error doska-notice" role="alert">
            {t(
              save.error instanceof ApiError && save.error.status === 409
                ? "projectConflictClose"
                : "saveError",
            )}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="doska-primary"
            disabled={save.isPending || Boolean(project.archivedAt)}
          >
            {t(confirmVisibility ? "confirm" : "save")}
          </button>
        </footer>
      </form>
      <DoskaProjectFieldsSettings
        projectId={project.id}
        disabled={Boolean(project.archivedAt)}
        onUpdated={async () => {
          try {
            const current = await api.getProject(project.id);
            if (
              current.name === project.name &&
              current.description === project.description &&
              current.visibility === project.visibility &&
              current.archivedAt === project.archivedAt
            )
              setRevision(current.revision);
          } catch {
            // Keep the old revision if the independent project refresh fails.
          }
        }}
      />
    </dialog>
  );
}
