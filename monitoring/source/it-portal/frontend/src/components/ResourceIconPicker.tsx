import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ResourceIcon } from "./common";
import { Button } from "./ui/button";
import {
  resourceIconChoices,
  type IconIdentity,
  type ResourceIconChoice,
} from "../resourceIcons";
import "./resource-icon-picker.css";

export function ResourceIconPicker({
  value,
  identity,
  onChange,
}: {
  value: ResourceIconChoice;
  identity: IconIdentity;
  onChange: (value: ResourceIconChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    resourceIconChoices.find((choice) => choice.key === value)?.label ||
    "Автоматически";
  return (
    <section className="resource-icon-picker" aria-label="Иконка карточки">
      <div className="resource-icon-picker-heading">
        <div>
          <strong>Иконка карточки</strong>
          <small>В каталоге, поиске и избранном</small>
        </div>
        <Button
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          aria-label={`Выбрать иконку: ${label}`}
        >
          <ResourceIcon {...identity} manualIcon={value} />
          <span>{label}</span>
          <ChevronDown size={15} />
        </Button>
      </div>
      {open && (
        <div
          className="resource-icon-options"
          role="group"
          aria-label="Выбор иконки"
        >
          <button
            type="button"
            aria-pressed={value === "auto"}
            onClick={() => onChange("auto")}
          >
            <ResourceIcon {...identity} />
            <span>Автоматически</span>
          </button>
          {resourceIconChoices.map((choice) => (
            <button
              type="button"
              key={choice.key}
              aria-pressed={value === choice.key}
              onClick={() => onChange(choice.key)}
            >
              <ResourceIcon manualIcon={choice.key} />
              <span>{choice.label}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
