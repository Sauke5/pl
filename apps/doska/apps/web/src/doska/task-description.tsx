import { useId, useLayoutEffect, useRef, useState } from "react";
import { Bold, Italic, List, Link, Quote } from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import "./task-description.css";
export function DoskaTaskDescription({
  value,
  label,
  editable,
  onChange,
}: {
  value: string;
  label: string;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("doska");
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const showingPreview = preview || !editable;
  useLayoutEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    const fit = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    };
    fit();
    let width = textarea.clientWidth;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (textarea.clientWidth !== width) {
              width = textarea.clientWidth;
              fit();
            }
          });
    observer?.observe(textarea);
    return () => observer?.disconnect();
  }, [value, showingPreview]);
  function format(kind: "bold" | "italic" | "list" | "link" | "quote") {
    const textarea = input.current;
    if (!textarea || !editable) return;
    const start = textarea.selectionStart,
      end = textarea.selectionEnd;
    const selected = value.slice(start, end) || t("descriptionTextPlaceholder");
    const replacement =
      kind === "bold"
        ? `**${selected}**`
        : kind === "italic"
          ? `_${selected}_`
          : kind === "link"
            ? `[${selected}](https://)`
            : selected
                .split("\n")
                .map((line) => `${kind === "list" ? "- " : "> "}${line}`)
                .join("\n");
    const prefix =
      (kind === "list" || kind === "quote") &&
      start > 0 &&
      value[start - 1] !== "\n"
        ? "\n"
        : "";
    const suffix =
      (kind === "list" || kind === "quote") &&
      end < value.length &&
      value[end] !== "\n"
        ? "\n"
        : "";
    const next =
      value.slice(0, start) + prefix + replacement + suffix + value.slice(end);
    if (next.length > 100000) return;
    onChange(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + replacement.length,
      );
    });
  }
  return (
    <section className="doska-task-description-block">
      <div className="doska-description-heading">
        <label htmlFor={id}>{label}</label>
        {editable && (
          <div className="doska-description-mode">
            <button
              type="button"
              aria-pressed={!showingPreview}
              onClick={() => setPreview(false)}
            >
              {t("edit")}
            </button>
            <button
              type="button"
              aria-pressed={showingPreview}
              onClick={() => setPreview(true)}
            >
              {t("descriptionPreview")}
            </button>
          </div>
        )}
      </div>
      {showingPreview ? (
        <div
          className="doska-description-preview"
          aria-label={t("descriptionPreview")}
        >
          {value ? (
            <ReactMarkdown
              skipHtml
              disallowedElements={["img"]}
              urlTransform={(url) =>
                /^(https?:|mailto:)/i.test(url) ? url : ""
              }
              components={{
                a: ({ href, children }) =>
                  href ? (
                    <a href={href} rel="noreferrer noopener" target="_blank">
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  ),
              }}
            >
              {value}
            </ReactMarkdown>
          ) : (
            <span className="doska-meta">{t("historyEmptyValue")}</span>
          )}
        </div>
      ) : (
        <>
          <div
            className="doska-description-format"
            role="group"
            aria-label={t("descriptionFormatting")}
          >
            {(
              [
                { kind: "bold", Icon: Bold, label: "descriptionBold" },
                { kind: "italic", Icon: Italic, label: "descriptionItalic" },
                { kind: "list", Icon: List, label: "descriptionList" },
                { kind: "link", Icon: Link, label: "descriptionLink" },
                { kind: "quote", Icon: Quote, label: "descriptionQuote" },
              ] as const
            ).map(({ kind, Icon, label: controlLabel }) => (
              <button
                type="button"
                key={kind}
                title={t(controlLabel)}
                aria-label={t(controlLabel)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => format(kind)}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
          <textarea
            id={id}
            ref={input}
            className="doska-task-description"
            rows={3}
            maxLength={100000}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      )}
    </section>
  );
}
