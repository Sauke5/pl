import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Archive,
  Check,
  ChevronRight,
  Copy,
  Network,
  Pencil,
  Star,
  X,
} from "lucide-react";
import { api, date, refresh, safeURL, useAPI } from "./api";
import type { Preferences, Resource } from "./types";
import { HelpButton, HelpFeedback, useHelpOpen, useHelpTopic } from "./Help";
import { Button } from "./components/ui/button";
import {
  ErrorBox,
  ExternalLink,
  JSONView,
  ResourceIcon,
} from "./components/common";
import { DoskaResourceTasks } from "./DoskaResourceTasks";
import { ResourceInventory } from "./Inventory";
import { ResourceConfigurationHistory } from "./ConnectionDetails";
import { isServiceCardResource } from "./serviceCardEligibility";
import { resourceKind } from "./resourceKind";
import "./resource-details.css";

type ResourceDetailsProps = {
  resource: Resource;
  onClose: () => void;
  onEdit: (resource: Resource) => void;
  onOperation: (kind: string, resource: Resource) => void;
  preferences?: Preferences;
  onPreferences?: (preferences: Preferences) => void;
  onDetails?: (resource: Resource) => void;
};

export function ResourceDetails(props: ResourceDetailsProps) {
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  return (
    <ResourceDetailsPanel
      key={props.resource.id}
      {...props}
      returnFocus={returnFocus.current}
    />
  );
}

function ResourceDetailsPanel({
  resource: r,
  onClose,
  onEdit,
  onOperation,
  preferences,
  onPreferences,
  onDetails,
  returnFocus,
}: ResourceDetailsProps & { returnFocus: HTMLElement | null }) {
  const helpOpen = useHelpOpen();
  useHelpTopic("resource-details", 10);
  const resources = useAPI<Resource[]>("/resources");
  const [error, setError] = useState<unknown>();
  const [archive, setArchive] = useState(false);
  const [pending, setPending] = useState(false);
  const [favoritePending, setFavoritePending] = useState(false);
  const [copied, setCopied] = useState("");
  const archiveLock = useRef(false);
  const mounted = useRef(true);
  const cancelArchive = useRef<HTMLButtonElement>(null);
  const starred = Boolean(preferences?.favorites.includes(r.id));
  const canFavorite = Boolean(
    preferences && onPreferences && (isServiceCardResource(r) || starred),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (archive) cancelArchive.current?.focus();
  }, [archive]);

  async function copyValue(label: string, value: string) {
    try {
      if (!navigator.clipboard)
        throw new Error("Копирование недоступно в этом браузере.");
      await navigator.clipboard.writeText(value);
      if (mounted.current) setCopied(label);
    } catch (reason) {
      if (mounted.current) setError(reason);
    }
  }
  async function toggleFavorite() {
    if (!preferences || !onPreferences || favoritePending || !canFavorite)
      return;
    setFavoritePending(true);
    try {
      await onPreferences({
        ...preferences,
        favorites: starred
          ? preferences.favorites.filter((id) => id !== r.id)
          : [...preferences.favorites, r.id],
      });
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      if (mounted.current) setFavoritePending(false);
    }
  }
  async function archiveNow() {
    if (archiveLock.current) return;
    archiveLock.current = true;
    setPending(true);
    setError(undefined);
    try {
      await api(`/resources/${r.id}`, "DELETE", undefined, {
        "If-Match": String(r.revision),
      });
      await refresh();
      if (mounted.current) onClose();
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      archiveLock.current = false;
      if (mounted.current) setPending(false);
    }
  }
  function address(label: string, value: string) {
    return (
      <div className="resource-details-address">
        <span>{label}</span>
        <div>
          <code>{value || "—"}</code>
          {value && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Скопировать ${label}`}
              title={`Скопировать ${label}`}
              onClick={() => void copyValue(label, value)}
            >
              {copied === label ? <Check size={16} /> : <Copy size={16} />}
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open && !helpOpen && !pending) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="resource-details-overlay" />
        <DialogPrimitive.Content
          className="resource-details-drawer"
          onEscapeKeyDown={(event) => {
            if (helpOpen || pending) event.preventDefault();
            else if (archive) {
              event.preventDefault();
              setArchive(false);
            }
          }}
          onInteractOutside={(event) => {
            if (helpOpen || pending || archive) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => {
              if (returnFocus?.isConnected)
                returnFocus.focus({ preventScroll: true });
            });
          }}
        >
          <header className="resource-details-heading">
            <ResourceIcon
              type={r.type}
              name={r.name}
              url={r.url}
              manualIcon={r.icon}
            />
            <div className="resource-details-identity">
              <DialogPrimitive.Title>{r.name}</DialogPrimitive.Title>
              <div className="resource-details-badges">
                <span className="resource-details-kind">
                  {resourceKind(r) === "applications"
                    ? "Приложение"
                    : r.type || "Инфраструктура"}
                </span>
                <span
                  className="resource-details-lifecycle"
                  data-lifecycle={r.lifecycle}
                >
                  {r.lifecycle === "active"
                    ? "Активен в каталоге"
                    : r.lifecycle === "archived"
                      ? "В архиве каталога"
                      : r.lifecycle || "Состояние каталога не указано"}
                </span>
              </div>
            </div>
            <div className="resource-details-heading-actions">
              <Button
                variant="ghost"
                size="icon"
                disabled={!canFavorite || favoritePending || pending}
                aria-pressed={starred}
                aria-label={
                  starred
                    ? `Убрать ${r.name} из избранного`
                    : `Добавить ${r.name} в избранное`
                }
                onClick={() => void toggleFavorite()}
              >
                <Star
                  size={20}
                  className={starred ? "starred" : ""}
                  fill={starred ? "currentColor" : "none"}
                />
              </Button>
              <HelpButton topic="resource-details" />
              <DialogPrimitive.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pending || helpOpen}
                  aria-label="Закрыть карточку ресурса"
                >
                  <X size={21} />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </header>
          <div className="resource-details-body">
            <DialogPrimitive.Description className="resource-details-description">
              {r.description || "Ресурс каталога инфраструктуры."}
            </DialogPrimitive.Description>
            {r.managed_module_id && (
              <p className="notice compact">
                Карточка создана модулем. Настройки, отключение и удаление
                доступны в его карточке.
              </p>
            )}
            {safeURL(r.url) && (
              <ExternalLink url={r.url} className="resource-details-open">
                Открыть {r.name}
              </ExternalLink>
            )}
            {r.url && (
              <div className="resource-details-url">
                {address("URL", r.url)}
              </div>
            )}
            <section
              className="resource-details-section"
              aria-label="Адрес и размещение"
            >
              <div className="resource-details-addresses">
                {address("IP", r.ip)}
                {address("Hostname", r.hostname)}
              </div>
              <dl className="resource-details-properties">
                <div>
                  <dt>Площадка</dt>
                  <dd>{r.site || "—"}</dd>
                </div>
                <div>
                  <dt>Среда</dt>
                  <dd>{r.environment || "—"}</dd>
                </div>
                <div className="resource-details-property-wide">
                  <dt>Направления</dt>
                  <dd>{r.directions?.join(", ") || "—"}</dd>
                </div>
              </dl>
              <div className="resource-details-tags">
                <span>Теги</span>
                {r.tags?.length ? (
                  r.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="muted">Не указаны</span>
                )}
              </div>
            </section>
            <section
              className="resource-details-section resource-details-check"
              aria-label="Проверка доступности"
            >
              <div className="resource-details-check-title">
                <Activity size={20} />
                <h3>Проверка доступности</h3>
              </div>
              {r.check?.kind ? (
                <p className="muted">
                  {r.check.kind.toUpperCase()} ·{" "}
                  {r.check.target || "Цель не указана"} ·{" "}
                  {r.check.interval_seconds
                    ? `каждые ${r.check.interval_seconds} с`
                    : "вручную"}
                </p>
              ) : (
                <span className="resource-details-check-unconfigured">
                  Не настроена
                </span>
              )}
            </section>
            {!!r.relations?.length && (
              <section className="resource-details-section">
                <h3>Связи</h3>
                {resources.error && <ErrorBox error={resources.error} />}
                <div className="resource-details-relations">
                  {r.relations.map((relation, index) => {
                    const related = resources.data?.find(
                      (resource) => resource.id === relation.resource_id,
                    );
                    return (
                      <button
                        type="button"
                        key={`${relation.resource_id}-${index}`}
                        className="resource-details-relation"
                        disabled={!related || !onDetails || pending}
                        onClick={() => {
                          if (related) onDetails?.(related);
                        }}
                      >
                        <Network size={19} />
                        <span>
                          {relation.label && <small>{relation.label}</small>}
                          <strong>
                            {related?.name ||
                              (resources.data
                                ? "Ресурс недоступен"
                                : "Загрузка ресурса…")}
                          </strong>
                        </span>
                        <ChevronRight size={18} />
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            <section className="resource-details-section resource-details-integrations">
              <DoskaResourceTasks key={r.id} resourceId={r.id} />
              <ResourceInventory resourceID={r.id} />
              <ResourceConfigurationHistory resourceID={r.id} />
            </section>
            {!!r.endpoints?.length && (
              <section className="resource-details-section">
                <h3>Точки входа</h3>
                <div className="link-list">
                  {r.endpoints.map((endpoint, index) => (
                    <ExternalLink key={index} url={endpoint.url}>
                      {endpoint.name}
                    </ExternalLink>
                  ))}
                </div>
              </section>
            )}
            {!!r.links?.length && (
              <section className="resource-details-section">
                <h3>Документация и диагностика</h3>
                <div className="link-list">
                  {r.links.map((link, index) => (
                    <ExternalLink key={index} url={link.url}>
                      {link.name}
                    </ExternalLink>
                  ))}
                </div>
              </section>
            )}
            {!!r.operations?.length && (
              <section className="resource-details-section">
                <h3>Действия</h3>
                <div className="actions">
                  {r.operations.includes("check") && (
                    <Button
                      disabled={pending}
                      onClick={() => onOperation("check", r)}
                    >
                      Запустить проверку
                    </Button>
                  )}
                  {r.operations.includes("report") && (
                    <Button
                      disabled={pending}
                      onClick={() => onOperation("report", r)}
                    >
                      Сформировать отчёт
                    </Button>
                  )}
                  {r.operations.includes("restart") && (
                    <Button
                      disabled={pending}
                      variant="destructive"
                      onClick={() => onOperation("restart", r)}
                    >
                      Перезапустить контейнер
                    </Button>
                  )}
                </div>
              </section>
            )}
            <details className="resource-details-section resource-details-extra">
              <summary>
                <span>
                  <strong>Дополнительные данные</strong>
                  <small>Aliases, источник и дата изменения</small>
                </span>
                <ChevronRight size={18} />
              </summary>
              <dl className="resource-details-properties">
                <div className="resource-details-property-wide">
                  <dt>Aliases</dt>
                  <dd>{r.aliases?.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt>Источник</dt>
                  <dd>{r.source || "—"}</dd>
                </div>
                <div>
                  <dt>Изменён</dt>
                  <dd>{r.updated_at ? date(r.updated_at) : "—"}</dd>
                </div>
              </dl>
              {!!r.external_ids?.length && (
                <div>
                  <h3>Внешние идентификаторы</h3>
                  <JSONView value={r.external_ids} />
                </div>
              )}
            </details>
            <span className="resource-details-sr-only" role="status">
              {copied ? `${copied} скопирован` : ""}
            </span>
          </div>
          <footer className="resource-details-footer">
            {!!error && <ErrorBox error={error} />}
            {archive && (
              <div
                className="resource-details-archive-confirm"
                role="group"
                aria-label="Подтверждение архивации"
              >
                <p>
                  Архивировать «{r.name}»? Запись сохранится в архиве и исчезнет
                  из активного каталога.
                </p>
                <div className="actions">
                  <Button
                    ref={cancelArchive}
                    disabled={pending}
                    onClick={() => setArchive(false)}
                  >
                    Отмена
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={pending}
                    onClick={() => void archiveNow()}
                  >
                    {pending ? "Архивируем…" : "Архивировать"}
                  </Button>
                </div>
              </div>
            )}
            <div className="resource-details-footer-actions">
              {!r.managed_module_id && r.lifecycle !== "archived" && (
                <Button
                  variant="ghost"
                  disabled={pending || archive}
                  onClick={() => {
                    setError(undefined);
                    setArchive(true);
                  }}
                >
                  <Archive size={17} />В архив
                </Button>
              )}
              {r.managed_module_id ? (
                <a
                  className="button button-primary"
                  href={`#modules?instance=${r.managed_module_id}`}
                  onClick={onClose}
                >
                  Управление модулем
                </a>
              ) : (
                <Button
                  variant="default"
                  disabled={pending}
                  onClick={() => onEdit(r)}
                >
                  <Pencil size={17} />
                  Редактировать
                </Button>
              )}
            </div>
            <HelpFeedback />
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
