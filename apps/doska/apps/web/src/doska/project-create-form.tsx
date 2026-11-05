import { useState, useEffect, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "./api";
import { TemplateOptions } from "./template-options";
import { TemplateComposition } from "./template-composition";
export function DoskaProjectCreateForm({
  onClose,
  onPendingChange,
}: {
  onClose: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t } = useTranslation("doska"),
    cache = useQueryClient();
  const [slugError, setSlugError] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [includeTasks, setIncludeTasks] = useState(true);
  const [stale, setStale] = useState(false);
  const template = useQuery({
    queryKey: ["doska", "template", templateId],
    queryFn: () => api.readTemplate(templateId),
    enabled: Boolean(templateId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const create = useMutation({
    mutationFn: (project: Parameters<typeof api.createProject>[0]) =>
      templateId
        ? api.createTemplateProject(templateId, {
            expectedRevision: template.data!.revision,
            includeTasks,
            project,
          })
        : api.createProject(project),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["doska", "projects"] });
      onClose();
    },
    onError: (error) => {
      if (templateId && error instanceof ApiError && error.status === 409) {
        setStale(true);
      }
    },
  });
  useEffect(() => {
    onPendingChange?.(create.isPending);
  }, [create.isPending, onPendingChange]);
  const ready =
    !templateId ||
    (template.isSuccess && !template.isError && !template.isFetching && !stale);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || create.isPending) return;
    const fields = new FormData(event.currentTarget);
    const slug = String(fields.get("slug")).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(slug)) {
      setSlugError(true);
      return;
    }
    create.mutate({
      name: String(fields.get("name")).trim(),
      slug,
      visibility: fields.get("visibility") as "department" | "private",
    });
  }
  return (
    <form onSubmit={submit}>
      <h2 id="new-project-title">{t("newProject")}</h2>
      <fieldset disabled={create.isPending}>
        <label className="doska-field">
          {t("projectName")}
          <input name="name" required maxLength={200} autoFocus />
        </label>
        <label className="doska-field">
          {t("projectSlug")}
          <input
            name="slug"
            required
            pattern={"[A-Za-z][A-Za-z0-9_\\-]{0,19}"}
            aria-invalid={slugError || undefined}
            aria-describedby="project-slug-help"
            onInvalid={() => setSlugError(true)}
            onChange={(event) => {
              setSlugError(!event.currentTarget.validity.valid);
              create.reset();
            }}
            maxLength={20}
          />
          <small
            id="project-slug-help"
            className={slugError ? "doska-error" : "doska-meta"}
            role={slugError ? "alert" : undefined}
          >
            {t("slugHelp")}
          </small>
        </label>
        <label className="doska-field">
          {t("visibility")}
          <select name="visibility">
            <option value="department">{t("department")}</option>
            <option value="private">{t("private")}</option>
          </select>
        </label>
        <TemplateOptions
          value={templateId}
          onChange={(id) => {
            setTemplateId(id);

            setStale(false);
            create.reset();
          }}
        />
        {templateId &&
          (template.isPending ? (
            <p role="status">{t("loading")}</p>
          ) : (
            template.data && (
              <>
                <label className="doska-bulk-check">
                  <input
                    type="checkbox"
                    checked={includeTasks}
                    onChange={(event) => {
                      setIncludeTasks(event.target.checked);
                    }}
                  />
                  {t("templateIncludeTasks")}
                </label>
                <TemplateComposition
                  snapshot={template.data.snapshot}
                  includeTasks={includeTasks}
                />
              </>
            )
          ))}
        {(create.isError || (templateId && template.isError)) && (
          <p className="doska-error" role="alert">
            {t(stale ? "templateChanged" : "saveError")}
            {templateId && (
              <button
                type="button"
                onClick={async () => {
                  const result = await template.refetch();
                  if (result.isSuccess) {
                    setStale(false);
                    create.reset();
                  }
                }}
              >
                {t("templateRefreshPreview")}
              </button>
            )}
          </p>
        )}
      </fieldset>
      <footer>
        <button type="button" disabled={create.isPending} onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="doska-primary" disabled={create.isPending || !ready}>
          {t(create.isPending ? "saving" : "create")}
        </button>
      </footer>
    </form>
  );
}
