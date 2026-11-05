import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, History, Save, X } from "lucide-react";
import { APIError } from "../api";
import { Button } from "../components/ui/button";
import { ErrorBox } from "../components/common";
import {
  displayValue,
  fieldLabels,
  same,
  selectFields,
  type FieldErrors,
} from "./model";

export type DraftController = {
  dirty: boolean;
  busy: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
};
export const DraftContext = createContext<
  (controller: DraftController) => () => void
>(() => () => {});
export function useDraftRegistration(controller: DraftController) {
  const register = useContext(DraftContext);
  useEffect(
    () => register(controller),
    [
      register,
      controller.dirty,
      controller.busy,
      controller.save,
      controller.discard,
    ],
  );
}

export function useSettingsDraft<T extends { revision: number }>({
  value,
  fields,
  validate,
  mutate,
  load,
}: {
  value: T;
  fields: string[];
  validate: (value: T) => FieldErrors;
  mutate: (value: T) => Promise<T>;
  load: () => Promise<T>;
}) {
  const [base, setBase] = useState(value);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<unknown>();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [conflict, setConflict] = useState<T>();
  const [saved, setSaved] = useState(false);
  const dirty = !same(selectFields(base, fields), selectFields(draft, fields));
  useEffect(() => {
    if (!dirty && value.revision > base.revision) {
      setBase(value);
      setDraft(value);
    }
  }, [value, dirty, base.revision]);
  function change(next: T | ((current: T) => T)) {
    setDraft(next);
    setSaved(false);
    setErrors({});
    setError(undefined);
  }
  function discard() {
    const latest = [base, conflict].reduce<T>(
      (current, candidate) =>
        candidate && candidate.revision > current.revision
          ? candidate
          : current,
      value,
    );
    setBase(latest);
    setDraft(latest);
    setError(undefined);
    setErrors({});
    setConflict(undefined);
    setSaved(false);
  }
  function focusInvalid() {
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(".settings-workspace [aria-invalid=true]")
        ?.focus(),
    );
  }
  function validateDraft() {
    const invalid = validate(draft);
    setErrors(invalid);
    setError(undefined);
    setSaved(false);
    if (Object.keys(invalid).length) {
      focusInvalid();
      return false;
    }
    return true;
  }
  async function save() {
    if (locked.current || !validateDraft()) return false;
    locked.current = true;
    setBusy(true);
    try {
      const updated = await mutate(draft);
      setBase(updated);
      setDraft(updated);
      setConflict(undefined);
      setSaved(true);
      return true;
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 409) {
        try {
          setConflict(await load());
        } catch {
          setError(cause);
        }
      } else {
        const details =
          cause instanceof APIError
            ? (cause as APIError & { fieldErrors?: unknown }).fieldErrors
            : undefined;
        if (details && typeof details === "object" && !Array.isArray(details)) {
          const serverErrors = Object.fromEntries(
            Object.entries(details).filter(
              ([field, message]) =>
                typeof message === "string" &&
                (fields.includes(field) ||
                  (fields.includes("config") && field.startsWith("config."))),
            ),
          );
          setErrors(serverErrors);
          if (Object.keys(serverErrors).length) focusInvalid();
        }
        setError(cause);
      }
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function resolve(next: T) {
    if (!conflict) return;
    setBase(conflict);
    setDraft(next);
    setConflict(undefined);
    setError(undefined);
    setErrors({});
  }
  return {
    base,
    draft,
    change,
    dirty,
    busy,
    error,
    errors,
    saved,
    save,
    discard,
    conflict,
    resolve,
    fields,
    validateDraft,
  };
}
export type DraftState<T extends { revision: number }> = ReturnType<
  typeof useSettingsDraft<T>
>;
function flat(value: unknown, fields: string[]): Record<string, unknown> {
  const selected = selectFields(value, fields);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(selected)) {
    if (key === "config" && entry && typeof entry === "object")
      for (const [name, val] of Object.entries(entry))
        out["config." + name] = val;
    else out[key] = entry;
  }
  return out;
}
function withValue<T>(value: T, path: string, entry: unknown): T {
  if (path.startsWith("config.")) {
    const object = value as T & { config: Record<string, unknown> };
    const config = { ...object.config };
    if (entry === undefined) delete config[path.slice(7)];
    else config[path.slice(7)] = entry;
    return { ...value, config };
  }
  return { ...value, [path]: entry };
}
export function ConflictReview<T extends { revision: number }>({
  state,
}: {
  state: DraftState<T>;
}) {
  const [choices, setChoices] = useState<Record<string, "mine" | "server">>({});
  if (!state.conflict) return null;
  const mine = flat(state.draft, state.fields),
    remote = flat(state.conflict, state.fields);
  const keys = [
    ...new Set([...Object.keys(mine), ...Object.keys(remote)]),
  ].filter((key) => !same(mine[key], remote[key]));
  function apply() {
    let result = state.conflict!;
    for (const key of keys)
      if (choices[key] === "mine") result = withValue(result, key, mine[key]);
    state.resolve(result);
  }
  return (
    <section className="settings-conflict" aria-label="Конфликт изменений">
      <h3>Настройки изменены другим администратором</h3>
      <p>Сверьте значения и выберите, какие оставить в черновике.</p>
      <div className="settings-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Параметр</th>
              <th>Ваш черновик</th>
              <th>Сохранено сейчас</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <th scope="row">{fieldLabels[key] || key}</th>
                <td>
                  <label>
                    <input
                      type="radio"
                      name={"conflict-" + key}
                      checked={choices[key] === "mine"}
                      onChange={() => setChoices({ ...choices, [key]: "mine" })}
                    />
                    {displayValue(mine[key])}
                  </label>
                </td>
                <td>
                  <label>
                    <input
                      type="radio"
                      name={"conflict-" + key}
                      checked={choices[key] === "server"}
                      onChange={() =>
                        setChoices({ ...choices, [key]: "server" })
                      }
                    />
                    {displayValue(remote[key])}
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <Button disabled={keys.some((key) => !choices[key])} onClick={apply}>
          Применить выбранное к черновику
        </Button>
        <Button onClick={() => state.resolve(state.conflict!)}>
          Загрузить актуальные
        </Button>
      </div>
    </section>
  );
}
export function DraftFooter({
  dirty,
  busy,
  saved,
  save,
  discard,
  history,
  error,
  conflict,
  children,
}: {
  dirty: boolean;
  busy: boolean;
  saved: boolean;
  save?: () => void;
  discard: () => void;
  history?: () => void;
  error?: unknown;
  conflict?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      {!!error && <ErrorBox error={error} />}
      <footer className="settings-savebar">
        <span className="settings-draft-state" role="status">
          {busy ? (
            "Сохранение…"
          ) : dirty ? (
            "Есть несохранённые изменения"
          ) : saved ? (
            <>
              <Check size={15} />
              Сохранено
            </>
          ) : (
            "Изменений нет"
          )}
        </span>
        <div className="actions">
          {history && (
            <Button size="sm" onClick={history} disabled={busy}>
              <History size={15} />
              История
            </Button>
          )}
          {children}
          <Button disabled={!dirty || busy} onClick={discard}>
            <X size={15} />
            Отменить изменения
          </Button>
          <Button
            variant="default"
            type={save ? "button" : "submit"}
            onClick={save}
            disabled={!dirty || busy || conflict}
          >
            <Save size={15} />
            Сохранить
          </Button>
        </div>
      </footer>
    </>
  );
}
export function FormField({
  name,
  label,
  hint,
  errors,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  errors?: FieldErrors;
  children: ReactNode;
}) {
  const error = errors?.[name];
  return (
    <div
      className={"settings-field" + (error ? " has-error" : "")}
      data-settings-field={name}
      tabIndex={-1}
    >
      <label htmlFor={"settings-" + name}>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
      {error && (
        <small
          id={"settings-error-" + name}
          className="settings-field-error"
          role="alert"
        >
          {error}
        </small>
      )}
    </div>
  );
}
export function inputProps(name: string, errors: FieldErrors = {}) {
  return {
    id: "settings-" + name,
    "aria-invalid": !!errors[name],
    "aria-describedby": errors[name] ? "settings-error-" + name : undefined,
  };
}
