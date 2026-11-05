import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "./api";
import {
  customFieldTypes,
  type CustomField,
  type ProjectFields,
  type RequiredTaskField,
} from "./custom-fields";
import { DoskaCustomFieldInput } from "./custom-field-input";
import "./custom-fields.css";
const standardFields = {
  description: "description",
  userId: "responsible",
  priority: "priority",
  startDate: "startDate",
  due: "dueDate",
} as const;
export function DoskaProjectFieldsSettings({
  projectId,
  disabled = false,
  onUpdated,
}: {
  projectId: string;
  disabled?: boolean;
  onUpdated?: () => Promise<void>;
}) {
  const { t } = useTranslation("doska");
  const fields = useQuery({
    queryKey: ["doska", "project-fields", projectId],
    queryFn: () => api.getProjectFields(projectId),
  });
  const [generation, setGeneration] = useState(0);
  return (
    <section className="doska-project-fields">
      <h3>{t("customFields")}</h3>
      {fields.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : fields.isError ? (
        <p role="alert">
          {t("loadError")}{" "}
          <button type="button" onClick={() => void fields.refetch()}>
            {t("retry")}
          </button>
        </p>
      ) : (
        <ProjectFieldControls
          key={generation}
          projectId={projectId}
          data={fields.data}
          disabled={disabled}
          onReload={async () => {
            const result = await fields.refetch();
            if (result.isSuccess) {
              setGeneration((value) => value + 1);
              await onUpdated?.();
            }
          }}
        />
      )}
    </section>
  );
}
function ProjectFieldControls({
  projectId,
  data,
  disabled,
  onReload,
}: {
  projectId: string;
  data: ProjectFields;
  disabled: boolean;
  onReload: () => Promise<void>;
}) {
  const { t } = useTranslation("doska");
  const cache = useQueryClient();
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [creating, setCreating] = useState(false);
  const [required, setRequired] = useState<RequiredTaskField[]>(
    data.requiredTaskFields,
  );
  const [revision, setRevision] = useState(data.revision);
  const [requiredRevision] = useState(data.revision);
  const [archiving, setArchiving] = useState<CustomField | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const roster = useQuery({
    queryKey: ["doska", "members", projectId],
    queryFn: () => api.listMembers(projectId),
    enabled: creating || Boolean(editing),
  });
  const people = roster.data
    ? [
        roster.data.owner,
        ...roster.data.members.filter(
          (person) => person.role === "participant",
        ),
      ]
    : [];
  const mutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setEditing(null);
      setCreating(false);
      setArchiving(null);
      await cache.invalidateQueries({
        queryKey: ["doska", "project-fields", projectId],
      });
      await onReload();
    },
  });
  const busy = disabled || mutation.isPending;
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  const blocked = busy || conflict;
  const formOpen = creating || Boolean(editing) || Boolean(archiving);
  const requiredDirty =
    JSON.stringify([...required].sort()) !==
    JSON.stringify([...data.requiredTaskFields].sort());
  const start = (field?: CustomField) => {
    mutation.reset();
    setRevision(data.revision);
    setEditing(field ?? null);
    setCreating(!field);
  };
  return (
    <>
      <h4>{t("requiredTaskFields")}</h4>
      <p className="doska-meta">{t("requiredTaskTitleAlways")}</p>
      <div className="doska-standard-required">
        {Object.entries(standardFields).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={required.includes(key as RequiredTaskField)}
              disabled={blocked || formOpen}
              onChange={(event) => {
                setRequired(
                  event.target.checked
                    ? [...required, key as RequiredTaskField]
                    : required.filter((value) => value !== key),
                );
              }}
            />
            {t(label)}
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={
          blocked ||
          formOpen ||
          JSON.stringify([...required].sort()) ===
            JSON.stringify([...data.requiredTaskFields].sort())
        }
        onClick={() =>
          mutation.mutate(() =>
            api.setRequiredTaskFields(projectId, {
              expectedRevision: requiredRevision,
              requiredTaskFields: required,
            }),
          )
        }
      >
        {t("save")}
      </button>
      <div className="doska-detail-actions">
        <button
          type="button"
          disabled={blocked || formOpen || requiredDirty}
          onClick={() => start()}
        >
          {t("customFieldAdd")}
        </button>
        <label>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />{" "}
          {t("archived")}
        </label>
      </div>
      <ul>
        {data.fields
          .filter((field) => Boolean(field.archivedAt) === showArchived)
          .sort((a, b) => a.position - b.position)
          .map((field, index, visible) => (
            <li key={field.id}>
              <span>
                {field.name}
                {field.required ? " *" : ""}
                <small>{t(`customFieldType_${field.type}`)}</small>
              </span>
              {!field.archivedAt && (
                <>
                  <button
                    type="button"
                    disabled={
                      blocked || formOpen || requiredDirty || index === 0
                    }
                    aria-label={t("customFieldMoveUp", { name: field.name })}
                    onClick={() => {
                      const ids = visible.map((item) => item.id);
                      [ids[index - 1], ids[index]] = [
                        ids[index],
                        ids[index - 1],
                      ];
                      mutation.mutate(() =>
                        api.reorderProjectFields(projectId, {
                          expectedRevision: data.revision,
                          fieldIds: ids,
                        }),
                      );
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={
                      blocked ||
                      formOpen ||
                      requiredDirty ||
                      index === visible.length - 1
                    }
                    aria-label={t("customFieldMoveDown", { name: field.name })}
                    onClick={() => {
                      const ids = visible.map((item) => item.id);
                      [ids[index + 1], ids[index]] = [
                        ids[index],
                        ids[index + 1],
                      ];
                      mutation.mutate(() =>
                        api.reorderProjectFields(projectId, {
                          expectedRevision: data.revision,
                          fieldIds: ids,
                        }),
                      );
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={blocked || formOpen || requiredDirty}
                    onClick={() => start(field)}
                  >
                    {t("edit")}
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={blocked || formOpen || requiredDirty}
                onClick={() => {
                  setRevision(data.revision);
                  setArchiving(field);
                  mutation.reset();
                }}
              >
                {t(
                  field.archivedAt
                    ? "customFieldRestore"
                    : "customFieldArchive",
                )}
              </button>
            </li>
          ))}
      </ul>
      {(creating || editing) && (
        <DefinitionForm
          key={editing?.id ?? "new"}
          field={editing}
          people={people}
          peopleReady={roster.isSuccess}
          disabled={blocked}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
            mutation.reset();
          }}
          onSave={(body) =>
            mutation.mutate(() =>
              editing
                ? api.updateProjectField(projectId, editing.id, {
                    expectedRevision: revision,
                    name: body.name,
                    required: body.required,
                    options: body.options,
                    defaultValue: body.defaultValue,
                  })
                : api.createProjectField(projectId, {
                    expectedRevision: revision,
                    ...body,
                  }),
            )
          }
        />
      )}
      {archiving && (
        <div className="doska-notice">
          <p>
            {t(
              archiving.archivedAt
                ? "customFieldRestoreConfirm"
                : "customFieldArchiveConfirm",
              { name: archiving.name },
            )}
          </p>
          <button
            type="button"
            disabled={blocked}
            onClick={() =>
              mutation.mutate(() =>
                api.updateProjectField(projectId, archiving.id, {
                  expectedRevision: revision,
                  archived: !archiving.archivedAt,
                }),
              )
            }
          >
            {t("confirm")}
          </button>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => {
              setArchiving(null);
              mutation.reset();
            }}
          >
            {t("cancel")}
          </button>
        </div>
      )}
      {mutation.isError && (
        <p role="alert" className="doska-error">
          {conflict
            ? t("customFieldsConflict")
            : mutation.error instanceof ApiError &&
                mutation.error.status === 400
              ? mutation.error.message
              : t("saveError")}
          {conflict && (
            <button type="button" onClick={() => void onReload()}>
              {t("refresh")}
            </button>
          )}
        </p>
      )}
      {roster.isError && formOpen && (
        <p role="alert">
          {t("membersLoadError")}{" "}
          <button type="button" onClick={() => void roster.refetch()}>
            {t("retry")}
          </button>
        </p>
      )}
    </>
  );
}
function DefinitionForm({
  field,
  people,
  peopleReady,
  disabled,
  onSave,
  onCancel,
}: {
  field: CustomField | null;
  people: { userId: string; name: string }[];
  peopleReady: boolean;
  disabled: boolean;
  onSave: (body: {
    name: string;
    type: CustomField["type"];
    required: boolean;
    defaultValue: string | null;
    options: string[] | null;
  }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("doska");
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<CustomField["type"]>(field?.type ?? "text");
  const [required, setRequired] = useState(field?.required ?? false);
  const [options, setOptions] = useState(field?.options?.join("\n") ?? "");
  const [defaultValue, setDefaultValue] = useState(field?.defaultValue ?? null);
  const choices =
    type === "dropdown" || type === "multiselect"
      ? options
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean)
      : null;
  const valid =
    name.trim() &&
    (!choices ||
      (choices.length > 0 && choices.length === new Set(choices).size));
  return (
    <form
      className="doska-custom-definition-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !disabled)
          onSave({
            name: name.trim(),
            type,
            required,
            defaultValue,
            options: choices,
          });
      }}
    >
      <fieldset className="doska-task-fields" disabled={disabled}>
        <label className="doska-field">
          {t("customFieldName")}
          <input
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="doska-field">
          {t("customFieldType")}
          <select
            value={type}
            disabled={Boolean(field)}
            onChange={(event) => {
              setType(event.target.value as CustomField["type"]);
              setDefaultValue(null);
            }}
          >
            {customFieldTypes.map((value) => (
              <option key={value} value={value}>
                {t(`customFieldType_${value}`)}
              </option>
            ))}
          </select>
        </label>
        {choices && (
          <label className="doska-field">
            {t("customFieldOptions")}
            <textarea
              rows={3}
              value={options}
              onChange={(event) => setOptions(event.target.value)}
            />
          </label>
        )}
        <label className="doska-field">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
          />
          {t("customFieldRequired")}
        </label>
        <DoskaCustomFieldInput
          field={{
            id: "default",
            name: t("customFieldDefault"),
            type,
            required: false,
            defaultValue: null,
            options: choices,
            position: 0,
            archivedAt: null,
          }}
          value={defaultValue}
          onChange={setDefaultValue}
          people={people}
          disabled={type === "user" && !peopleReady}
        />
        <footer>
          <button type="button" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button type="submit" className="doska-primary" disabled={!valid}>
            {t("save")}
          </button>
        </footer>
      </fieldset>
    </form>
  );
}
