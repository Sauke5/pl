import { useRef, useState } from "react";
import { BookOpen, Clock, Shield } from "lucide-react";
import { api, queryClient, useAPI } from "../api";
import type { Settings, Dictionaries, Resource } from "../types";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { ErrorBox } from "../components/common";
import {
  ConflictReview,
  DraftFooter,
  FormField,
  inputProps,
  useDraftRegistration,
  useSettingsDraft,
} from "./Draft";
import { isServiceCardResource } from "../serviceCardEligibility";
import { SettingsHistory } from "./History";
import {
  dictionaryFields,
  fieldLabels,
  generalFields,
  publicationFields,
  selectFields,
  validateDictionaries,
  validateGeneral,
  validatePublication,
} from "./model";

function updateSettings(value: Settings) {
  queryClient.setQueryData(["/settings"], value);
  void queryClient.invalidateQueries({ queryKey: ["/session"] });
}
async function latestSettings() {
  const value = await api<Settings>("/settings");
  queryClient.setQueryData(["/settings"], value);
  return value;
}
export function GeneralSettings({ value }: { value: Settings }) {
  const [history, setHistory] = useState(false);
  const state = useSettingsDraft({
    value,
    fields: generalFields,
    validate: validateGeneral,
    mutate: async (draft) => {
      const result = await api<Settings>("/settings-workspace/general", "PUT", {
        revision: draft.revision,
        ...selectFields(draft, generalFields),
      });
      updateSettings(result);
      return result;
    },
    load: latestSettings,
  });
  useDraftRegistration(state);
  return (
    <section className="settings-group" aria-label="Время и данные">
      <header className="settings-section-heading">
        <Clock size={22} />
        <div>
          <h2>Время и данные</h2>
          <p>Как показывать время и определять актуальность показателей</p>
        </div>
      </header>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void state.save();
        }}
      >
        <fieldset disabled={state.busy}>
          <FormField
            name="timezone"
            label="Часовой пояс"
            errors={state.errors}
            hint="Используется для времени событий, графиков и часов на главной."
          >
            <input
              {...inputProps("timezone", state.errors)}
              list="settings-timezones"
              value={state.draft.timezone}
              onChange={(e) =>
                state.change({ ...state.draft, timezone: e.target.value })
              }
            />
            <datalist id="settings-timezones">
              {[
                "Europe/Moscow",
                "Europe/Kaliningrad",
                "Europe/Samara",
                "Asia/Yekaterinburg",
                "Asia/Novosibirsk",
                "Asia/Krasnoyarsk",
                "Asia/Irkutsk",
                "Asia/Vladivostok",
                "UTC",
              ].map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </FormField>
          <FormField
            name="stale_after_seconds"
            label="Данные устаревают через, с"
            errors={state.errors}
            hint="Если за это время не было успешного сбора, PL пометит показатели как устаревшие. Например, 180 секунд — 3 минуты. Допустимо от 30 секунд до суток."
          >
            <input
              {...inputProps("stale_after_seconds", state.errors)}
              type="number"
              min={30}
              max={86400}
              step={1}
              value={
                Number.isFinite(state.draft.stale_after_seconds)
                  ? state.draft.stale_after_seconds
                  : ""
              }
              onChange={(e) =>
                state.change({
                  ...state.draft,
                  stale_after_seconds:
                    e.target.value === "" ? NaN : Number(e.target.value),
                })
              }
            />
          </FormField>
        </fieldset>
        {state.conflict && (
          <ConflictReview key={state.conflict.revision} state={state} />
        )}
        <DraftFooter
          {...state}
          conflict={!!state.conflict}
          history={() => setHistory((open) => !open)}
        />
      </form>
      {history && (
        <SettingsHistory
          key={state.base.revision}
          target={{ kind: "settings", id: "global", group: "general" }}
          onClose={() => setHistory(false)}
        />
      )}
    </section>
  );
}
export function PublicationSettings({ value }: { value: Settings }) {
  const resources = useAPI<Resource[]>("/resources");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const approval = useRef<((answer: boolean) => void) | undefined>(undefined);
  const state = useSettingsDraft({
    value,
    fields: publicationFields,
    validate: validatePublication,
    mutate: async (draft) => {
      const result = await api<Settings>(
        "/settings-workspace/publication",
        "PUT",
        { revision: draft.revision, ...selectFields(draft, publicationFields) },
      );
      updateSettings(result);
      return result;
    },
    load: latestSettings,
  });
  const base = state.base,
    draft = state.draft;
  const expanding =
    draft.board_enabled &&
    (!base.board_enabled ||
      (draft.board_anonymous && !base.board_anonymous) ||
      draft.board_resource_ids.some(
        (id) => !base.board_resource_ids.includes(id),
      ));
  const saving = useRef(false);
  async function save() {
    if (saving.current) return false;
    if (Object.keys(validatePublication(draft)).length) return state.save();
    saving.current = true;
    try {
      if (expanding) {
        const allowed = await new Promise<boolean>((resolve) => {
          approval.current = resolve;
          setConfirming(true);
        });
        if (!allowed) return false;
      }
      return await state.save();
    } finally {
      saving.current = false;
    }
  }
  function answer(allowed: boolean) {
    setConfirming(false);
    const resolve = approval.current;
    approval.current = undefined;
    resolve?.(allowed);
  }
  useDraftRegistration({ ...state, save });
  const visible =
    resources.data?.filter(
      (resource) =>
        isServiceCardResource(resource) &&
        (resource.name + " " + resource.description)
          .toLocaleLowerCase("ru")
          .includes(query.trim().toLocaleLowerCase("ru")),
    ) || [];
  const unknown = draft.board_resource_ids.filter(
    (id) =>
      resources.data &&
      !resources.data.some(
        (resource) => resource.id === id && isServiceCardResource(resource),
      ),
  );
  function toggleResource(id: string, checked: boolean) {
    state.change({
      ...draft,
      board_resource_ids: checked
        ? [...draft.board_resource_ids, id]
        : draft.board_resource_ids.filter((current) => current !== id),
    });
  }
  return (
    <section className="settings-group" aria-label="Страница для пользователей">
      <header className="settings-section-heading">
        <Shield size={22} />
        <div>
          <h2>Страница для пользователей</h2>
          <p>
            Выберите сервисы для общей страницы Board и настройте доступ к ней
          </p>
        </div>
      </header>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={state.busy || confirming}>
          <div
            className="settings-field"
            data-settings-field="board_enabled"
            tabIndex={-1}
          >
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={draft.board_enabled}
                onChange={(e) =>
                  state.change({
                    ...draft,
                    board_enabled: e.target.checked,
                    board_anonymous: e.target.checked && draft.board_anonymous,
                  })
                }
              />
              Публикация Board включена
            </label>
            <small>Выбранные ресурсы доступны через страницу Board.</small>
          </div>
          <div
            className="settings-field"
            data-settings-field="board_anonymous"
            tabIndex={-1}
          >
            <label className="settings-toggle">
              <input
                {...inputProps("board_anonymous", state.errors)}
                type="checkbox"
                checked={draft.board_anonymous}
                disabled={!draft.board_enabled}
                onChange={(e) =>
                  state.change({ ...draft, board_anonymous: e.target.checked })
                }
              />
              Разрешить анонимный доступ
            </label>
            <small>Открытие Board без входа в Платформу.</small>
            {state.errors.board_anonymous && (
              <small role="alert" className="settings-field-error">
                {state.errors.board_anonymous}
              </small>
            )}
          </div>
          <FormField
            name="board_title"
            label="Заголовок Board"
            errors={state.errors}
          >
            <input
              {...inputProps("board_title", state.errors)}
              value={draft.board_title}
              maxLength={160}
              onChange={(e) =>
                state.change({ ...draft, board_title: e.target.value })
              }
            />
          </FormField>
          <div
            className="settings-field"
            data-settings-field="board_resource_ids"
            tabIndex={-1}
          >
            <div className="settings-heading">
              <h3>Публикуемые ресурсы</h3>
              <span className="muted">
                Выбрано: {draft.board_resource_ids.length}
              </span>
            </div>
            <small>
              В Board будут видны названия и описания выбранных ресурсов.
            </small>
            <input
              type="search"
              aria-label="Найти ресурс для публикации"
              placeholder="Найти ресурс"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {resources.error ? (
              <ErrorBox
                error={resources.error}
                retry={() => void resources.refetch()}
              />
            ) : resources.isPending ? (
              <p role="status">Загрузка ресурсов…</p>
            ) : (
              <div
                className="settings-resource-list"
                aria-label="Ресурсы для публикации"
              >
                {visible.map((resource) => (
                  <label key={resource.id}>
                    <input
                      type="checkbox"
                      checked={draft.board_resource_ids.includes(resource.id)}
                      onChange={(e) =>
                        toggleResource(resource.id, e.target.checked)
                      }
                    />
                    <span>
                      <strong>{resource.name}</strong>
                      <small>{resource.description}</small>
                    </span>
                  </label>
                ))}
                {unknown.map((id) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() => toggleResource(id, false)}
                    />
                    <span>
                      Прежний выбор · карточка не публикуется{" "}
                      <small>{id}</small>
                    </span>
                  </label>
                ))}
                {!visible.length && !unknown.length && (
                  <p className="muted">
                    {query
                      ? "Ресурсы не найдены"
                      : "В каталоге пока нет ресурсов"}
                  </p>
                )}
              </div>
            )}
            {state.errors.board_resource_ids && (
              <small className="settings-field-error" role="alert">
                {state.errors.board_resource_ids}
              </small>
            )}
          </div>
        </fieldset>
        {state.conflict && (
          <ConflictReview key={state.conflict.revision} state={state} />
        )}
        <DraftFooter
          {...state}
          save={() => void save()}
          conflict={!!state.conflict}
          history={() => setHistory((open) => !open)}
        />
      </form>
      {history && (
        <SettingsHistory
          key={state.base.revision}
          target={{ kind: "settings", id: "global", group: "publication" }}
          onClose={() => setHistory(false)}
        />
      )}
      {confirming && (
        <Dialog title="Расширить доступ к Board?" onClose={() => answer(false)}>
          <p>
            {draft.board_anonymous
              ? "Board будет доступен без входа в Платформу."
              : "Выбранные ресурсы станут доступны пользователям Board."}
          </p>
          <p>Будет опубликовано ресурсов: {draft.board_resource_ids.length}.</p>
          <div className="dialog-footer">
            <Button onClick={() => answer(false)}>Отмена</Button>
            <Button variant="default" onClick={() => answer(true)}>
              Подтвердить публикацию
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
export function DictionarySettings({ value }: { value: Dictionaries }) {
  const relationTypes = [
    "Размещено на",
    "Использует БД",
    "Зависит от",
    "Резервируется на",
  ];
  const normalize = (source: Dictionaries): Dictionaries => ({
    ...source,
    relation_types: source.relation_types ?? relationTypes,
  });
  const [history, setHistory] = useState(false);
  const state = useSettingsDraft({
    value: normalize(value),
    fields: dictionaryFields,
    validate: validateDictionaries,
    mutate: async (draft) => {
      const result = await api<Dictionaries>(
        "/settings-workspace/dictionaries",
        "PUT",
        draft,
      );
      queryClient.setQueryData(["/dictionaries"], result);
      return result;
    },
    load: async () => {
      const result = await api<Dictionaries>("/dictionaries");
      queryClient.setQueryData(["/dictionaries"], result);
      return normalize(result);
    },
  });
  useDraftRegistration(state);
  return (
    <section className="settings-group" aria-label="Справочники">
      <header className="settings-section-heading">
        <BookOpen size={22} />
        <div>
          <h2>Справочники</h2>
          <p>Общие значения для карточек и фильтров каталога</p>
        </div>
      </header>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void state.save();
        }}
      >
        <fieldset disabled={state.busy}>
          {dictionaryFields.map((key) => (
            <FormField
              key={key}
              name={key}
              label={fieldLabels[key]}
              errors={state.errors}
              hint={
                key === "relation_types"
                  ? "По одному значению на строку. Изменения не меняют уже сохранённые связи ресурсов."
                  : "По одному значению на строку. До 200 значений."
              }
            >
              <textarea
                {...inputProps(key, state.errors)}
                rows={5}
                value={
                  state.draft[
                    key as keyof Omit<Dictionaries, "revision">
                  ]?.join("\n") ?? ""
                }
                onChange={(e) =>
                  state.change({
                    ...state.draft,
                    [key]: e.target.value.split("\n"),
                  })
                }
                onBlur={() =>
                  state.change((current) => ({
                    ...current,
                    [key]: (
                      current[key as keyof Omit<Dictionaries, "revision">] ?? []
                    )
                      .map((entry) => entry.trim())
                      .filter(Boolean),
                  }))
                }
              />
            </FormField>
          ))}
        </fieldset>
        {state.conflict && (
          <ConflictReview key={state.conflict.revision} state={state} />
        )}
        <DraftFooter
          {...state}
          conflict={!!state.conflict}
          history={() => setHistory((open) => !open)}
        />
      </form>
      {history && (
        <SettingsHistory
          key={state.base.revision}
          target={{ kind: "dictionaries", id: "global" }}
          onClose={() => setHistory(false)}
        />
      )}
    </section>
  );
}
