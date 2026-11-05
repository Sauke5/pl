import { useTranslation } from "react-i18next";
import { DoskaCustomFieldInput } from "./custom-field-input";
import {
  fieldEmpty,
  fieldValue,
  patchFieldValue,
  type CustomField,
  type CustomValues,
  type FieldPerson,
} from "./custom-fields";
import "./custom-fields.css";
export function DoskaTaskCustomFields({
  fields,
  values,
  baseline,
  creating,
  people,
  onChange,
}: {
  fields: CustomField[];
  values: CustomValues;
  baseline: CustomValues;
  creating: boolean;
  people: FieldPerson[];
  onChange: (values: CustomValues) => void;
}) {
  const { t } = useTranslation("doska");
  const active = fields
    .filter((field) => !field.archivedAt)
    .sort((a, b) => a.position - b.position);
  if (!active.length) return null;
  return (
    <section
      className="doska-task-custom-fields"
      aria-label={t("customFields")}
    >
      <h4>{t("customFields")}</h4>
      <div className="doska-custom-field-grid">
        {active.map((field) => (
          <DoskaCustomFieldInput
            key={field.id}
            field={field}
            value={fieldValue(field, values, creating)}
            people={people}
            required={
              field.required &&
              (creating ||
                !fieldEmpty(field, fieldValue(field, baseline, false)))
            }
            onChange={(value) =>
              onChange(patchFieldValue(values, field.id, value))
            }
          />
        ))}
      </div>
    </section>
  );
}
