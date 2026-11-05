import { useTranslation } from "react-i18next";
import {
  type CustomField,
  type FieldPerson,
  selectedOptions,
} from "./custom-fields";
export function DoskaCustomFieldInput({
  field,
  value,
  onChange,
  people = [],
  required = false,
  disabled = false,
}: {
  field: CustomField;
  value: string | null;
  onChange: (value: string | null) => void;
  people?: FieldPerson[];
  required?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation("doska");
  const label = `${field.name}${field.required ? " *" : ""}`;
  if (field.type === "multiselect") {
    const selected = selectedOptions(value);
    return (
      <fieldset className="doska-custom-multiselect" disabled={disabled}>
        <legend>{label}</legend>
        {[
          ...(field.options ?? []),
          ...selected.filter((option) => !field.options?.includes(option)),
        ].map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={(event) =>
                onChange(
                  JSON.stringify(
                    event.target.checked
                      ? [...selected, option]
                      : selected.filter((item) => item !== option),
                  ),
                )
              }
            />
            {option}
            {!field.options?.includes(option) && (
              <small>{t("customFieldLegacyOption")}</small>
            )}
          </label>
        ))}
      </fieldset>
    );
  }
  if (
    field.type === "boolean" ||
    field.type === "dropdown" ||
    field.type === "user"
  ) {
    const options =
      field.type === "boolean"
        ? [
            { value: "true", label: t("historyYes") },
            { value: "false", label: t("historyNo") },
          ]
        : field.type === "user"
          ? people.map((person) => ({
              value: person.userId,
              label: person.name,
            }))
          : (field.options ?? []).map((option) => ({
              value: option,
              label: option,
            }));
    return (
      <label className="doska-field">
        {label}
        <select
          required={required}
          disabled={disabled}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{t("customFieldUnset")}</option>
          {value && !options.some((option) => option.value === value) && (
            <option value={value}>
              {field.type === "user" ? t("unavailableMember") : value}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="doska-field">
      {label}
      <input
        type={
          field.type === "number"
            ? "number"
            : field.type === "date"
              ? "date"
              : "text"
        }
        step={field.type === "number" ? "any" : undefined}
        maxLength={field.type === "text" ? 10000 : undefined}
        required={required}
        disabled={disabled}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </label>
  );
}
