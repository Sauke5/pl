import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, type SaveTemplateInput } from "./api";
import { TemplateOptions } from "./template-options";
import { TemplateComposition } from "./template-composition";
export function DoskaTemplateSave({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("doska"),
    cache = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const hydratedTemplate = useRef("");
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [visibility, setVisibility] =
    useState<SaveTemplateInput["visibility"]>("private");
  const [stale, setStale] = useState(false);
  const preview = useQuery({
    queryKey: ["doska", "template-preview", projectId],
    queryFn: () => api.previewTemplate(projectId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const existing = useQuery({
    queryKey: ["doska", "template", templateId],
    queryFn: () => api.readTemplate(templateId),
    enabled: Boolean(templateId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (existing.data && hydratedTemplate.current !== templateId) {
      hydratedTemplate.current = templateId;
      setExpectedRevision(existing.data.revision);
      setName(existing.data.name);
      setVisibility(existing.data.visibility);
    }
  }, [existing.data, templateId]);
  const save = useMutation({
    mutationFn: () =>
      api.saveTemplate({
        sourceProjectId: projectId,
        fingerprint: preview.data!.fingerprint,
        name: name.trim(),
        visibility,
        ...(templateId
          ? { templateId, expectedRevision: expectedRevision! }
          : {}),
      }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["doska", "templates"] });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setStale(true);
      }
    },
  });
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const refresh = async () => {
    const [sourceResult, templateResult] = await Promise.all([
      preview.refetch(),
      templateId ? existing.refetch() : Promise.resolve(null),
    ]);
    if (sourceResult.isSuccess && (!templateId || templateResult?.isSuccess)) {
      if (templateResult?.data)
        setExpectedRevision(templateResult.data.revision);
      setStale(false);
      save.reset();
    }
  };
  const ready =
    preview.isSuccess &&
    !preview.isError &&
    !preview.isFetching &&
    !stale &&
    (!templateId ||
      (existing.isSuccess &&
        !existing.isError &&
        existing.data.canManage &&
        expectedRevision !== null));
  return (
    <dialog
      ref={ref}
      className="doska-dialog doska-template-dialog"
      aria-labelledby="save-template-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!save.isPending) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !save.isPending) save.mutate();
        }}
      >
        <h2 id="save-template-heading">{t("templateSave")}</h2>
        <fieldset disabled={save.isPending}>
          <TemplateOptions
            value={templateId}
            manageOnly
            onChange={(id) => {
              hydratedTemplate.current = "";
              setExpectedRevision(null);
              setTemplateId(id);

              setName("");
              setVisibility("private");
            }}
          />
          <label className="doska-field">
            {t("templateName")}
            <input
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="doska-field">
            {t("templateAudience")}
            <select
              value={visibility}
              onChange={(event) => {
                setVisibility(event.target.value as typeof visibility);
              }}
            >
              {(["private", "department", "company"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`templateAudience_${value}`)}
                </option>
              ))}
            </select>
          </label>
          {preview.isPending ? (
            <p role="status">{t("loading")}</p>
          ) : (
            preview.data && (
              <TemplateComposition snapshot={preview.data.snapshot} />
            )
          )}
          {(preview.isError || existing.isError || save.isError) && (
            <p role="alert" className="doska-error">
              {t(stale ? "templateChanged" : "saveError")}{" "}
              <button type="button" onClick={() => void refresh()}>
                {t("templateRefreshPreview")}
              </button>
            </p>
          )}
          <p className="doska-template-audience">
            {t("templateAudience")}:{" "}
            <strong>{t(`templateAudience_${visibility}`)}</strong>
          </p>
        </fieldset>
        <footer>
          <button type="button" disabled={save.isPending} onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="doska-primary"
            disabled={!ready || !name.trim() || save.isPending}
          >
            {t(
              save.isPending
                ? "saving"
                : templateId
                  ? "templateUpdate"
                  : "save",
            )}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
