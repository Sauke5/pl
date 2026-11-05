import { useEffect, useId, useRef, useState } from "react";
import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "./api";
import "./task-color-picker.css";
export function DoskaTaskColorPicker({
  value,
  disabled,
  onChange,
}: {
  value: Task["cardColor"];
  disabled: boolean;
  onChange: (value: Task["cardColor"]) => void;
}) {
  const { t } = useTranslation("doska");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
        if (event.target instanceof HTMLDialogElement) event.stopPropagation();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    ref.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <div className="doska-color-picker" ref={ref}>
      <button
        type="button"
        ref={trigger}
        className="doska-color-picker-trigger"
        disabled={disabled}
        aria-label={t("cardColor")}
        title={t("cardColor")}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Palette size={18} />
      </button>
      {open && (
        <div id={id} className="doska-color-picker-panel">
          <fieldset disabled={disabled}>
            <legend>{t("cardColor")}</legend>
            <div className="doska-task-color-palette">
              {(
                [
                  null,
                  "blue",
                  "cyan",
                  "green",
                  "yellow",
                  "orange",
                  "red",
                  "pink",
                  "purple",
                ] as const
              ).map((color) => (
                <label
                  key={color ?? "default"}
                  className={`doska-color-option doska-color-${color ?? "default"}`}
                  title={t(`cardColor_${color ?? "default"}`)}
                >
                  <input
                    type="radio"
                    name={id}
                    checked={value === color}
                    onChange={() => {
                      onChange(color);
                      setOpen(false);
                      trigger.current?.focus();
                    }}
                  />
                  <span>{t(`cardColor_${color ?? "default"}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
