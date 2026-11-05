import { ActionFeedback } from "./ActionNotifications";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Download,
  Folder,
  FolderPlus,
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Job } from "./types";
import { APIError, api, queryClient, useAPI } from "./api";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import "./sftpgo.css";

type Permissions = Record<string, string[]>;
type VirtualFolder = {
  name: string;
  virtual_path: string;
  quota_size: number;
  quota_files: number;
};
type Limits = {
  quota_size: number;
  quota_files: number;
  max_sessions: number;
  upload_bandwidth: number;
  download_bandwidth: number;
};
type Group = Limits & {
  name: string;
  description: string;
  permissions: Permissions;
  virtual_folders: VirtualFolder[];
};
type SharedFolder = {
  name: string;
  description: string;
  used_quota_size?: number;
  used_quota_files?: number;
  users?: string[];
};
type SFTPUser = Limits & {
  username: string;
  description: string;
  enabled: boolean;
  password_enabled: boolean;
  public_key_enabled: boolean;
  public_keys: string[];
  has_password?: boolean;
  permissions: Permissions;
  groups: { name: string; type: 1 | 2 | 3 }[];
  virtual_folders: VirtualFolder[];
  used_quota_size?: number;
  used_quota_files?: number;
  updated_at?: number | string;
};
type Configuration = {
  listen_ip: string;
  port: number;
  revision: number;
  configuration_hash?: string;
};
type Status = {
  version?: string;
  state?: string;
  client_authenticated?: boolean;
  client_username?: string;
  configuration?: Configuration;
};
type FileEntry = {
  name: string;
  type: "dir" | "file" | "other";
  size: number;
  modified_at?: number | string;
};
type FileListing = { path: string; entries: FileEntry[] };
type Tab = "files" | "users" | "groups" | "folders" | "settings";
const permissions = [
  ["list", "Просмотр"],
  ["download", "Скачивание"],
  ["upload", "Загрузка"],
  ["overwrite", "Перезапись"],
  ["delete", "Удаление"],
  ["rename", "Переименование"],
  ["create_dirs", "Создание папок"],
] as const;
const stateLabels: Record<string, string> = {
  disabled: "Отключён",
  error: "Ошибка",
  pending: "Запускается",
};
const emptyLimits: Limits = {
  quota_size: 0,
  quota_files: 0,
  max_sessions: 0,
  upload_bandwidth: 0,
  download_bandwidth: 0,
};
const defaultPermissions = () => ({ "/": ["list", "download"] });
const list = (text: string) =>
  text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
function validMappingPath(value: string) {
  return (
    value.startsWith("/") &&
    value !== "/" &&
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    !value
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  );
}
function validateAccess(acl: Permissions, folders: VirtualFolder[]) {
  if (!acl["/"]?.length || Object.values(acl).some((rights) => !rights.length))
    throw new Error("Выберите хотя бы одно право для каждого пути.");
  if (
    folders.some((folder) => !validMappingPath(folder.virtual_path)) ||
    new Set(folders.map((folder) => folder.virtual_path)).size !==
      folders.length
  )
    throw new Error(
      "Укажите для каждой общей папки отдельный путь внутри корня, например /documents.",
    );
}
const childPath = (parent: string, name: string) =>
  `${parent === "/" ? "" : parent}/${name}`;
function bytes(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const units = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"];
  let size = value,
    unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[unit]}`;
}
function changedAt(value?: string | number) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU");
}
function nativeAuthenticationError(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    [
      "sftpgo_authentication_required",
      "sftpgo_authentication_expired",
    ].includes(error.code)
  );
}
function friendly(error: unknown) {
  if (nativeAuthenticationError(error))
    return new Error(
      "Войдите в файловый сервер заново. Проверьте логин и пароль файловой учётной записи.",
    );
  if (error instanceof APIError && error.status === 403)
    return new Error("Файловая учётная запись не разрешает это действие.");
  return error;
}
function useActions(base: string) {
  const intent = useRef<{ signature: string; key: string } | undefined>(
    undefined,
  );
  return async <T,>(suffix: string, method: string, body?: unknown) => {
    const signature = JSON.stringify([suffix, method, body]);
    if (intent.current?.signature !== signature)
      intent.current = { signature, key: crypto.randomUUID() };
    const result = await api<T>(base + suffix, method, body, {
      "Idempotency-Key": intent.current.key,
    });
    intent.current = undefined;
    return result;
  };
}
async function refresh(base: string) {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === "string" &&
      query.queryKey[0].startsWith(base),
  });
}

export function SFTPGo({
  instanceID,
  admin,
}: {
  instanceID: string;
  admin: boolean;
}) {
  const base = `/modules/${encodeURIComponent(instanceID)}/sftpgo`;
  const status = useAPI<Status>(base + "/status");
  const [selected, setSelected] = useState<Tab>("files");
  const tab = admin ? selected : "files";
  return (
    <div className="sftpgo-module">
      <Panel
        title="Файловый сервер"
        icon={<Folder size={21} />}
        action={
          <Button size="sm" onClick={() => void refresh(base)}>
            <RefreshCw size={15} /> Обновить
          </Button>
        }
      >
        <div className="sftpgo-status">
          <Badge value={status.data?.state === "running" ? "ok" : "unknown"}>
            {status.data?.state === "running"
              ? "Работает"
              : status.isPending
                ? "Проверяем состояние…"
                : stateLabels[status.data?.state || ""] ||
                  "Состояние не подтверждено"}
          </Badge>
          <span>SFTPGo {status.data?.version || "—"}</span>
          {status.data?.configuration && (
            <span>
              SFTP: {status.data.configuration.listen_ip}:
              {status.data.configuration.port}
            </span>
          )}
        </div>
        <p className="muted">
          Файлы и доступ к ним управляются отдельными файловыми учётными
          записями.
        </p>
        {status.error && (
          <ErrorBox error={status.error} retry={() => void status.refetch()} />
        )}
      </Panel>
      {admin && (
        <nav className="sftpgo-tabs" aria-label="Разделы файлового сервера">
          {(
            [
              ["files", "Файлы"],
              ["users", "Учётные записи"],
              ["groups", "Группы"],
              ["folders", "Общие папки"],
              ["settings", "Подключение SFTP"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={tab === value ? "default" : "ghost"}
              aria-current={tab === value ? "page" : undefined}
              onClick={() => setSelected(value)}
            >
              {label}
            </Button>
          ))}
        </nav>
      )}
      {tab === "files" && (
        <FileBrowser
          key={instanceID}
          base={base}
          authenticated={status.data?.client_authenticated === true}
          username={status.data?.client_username}
          statusLoading={status.isPending || !!status.error}
        />
      )}
      {admin && tab === "users" && <UsersPanel base={base} />}
      {admin && tab === "groups" && <GroupsPanel base={base} />}
      {admin && tab === "folders" && <FoldersPanel base={base} />}
      {admin && tab === "settings" && <SettingsPanel base={base} />}
    </div>
  );
}

function PermissionFields({
  value,
  onChange,
  title = "Права в корневой папке",
  disabled = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="sftpgo-permissions" disabled={disabled}>
      <legend>{title}</legend>
      {value
        .filter((key) => !permissions.some(([known]) => known === key))
        .map((key) => (
          <label key={key}>
            <input
              type="checkbox"
              checked
              onChange={() => onChange(value.filter((item) => item !== key))}
            />
            {key === "*"
              ? "Полный доступ (все права)"
              : `Дополнительное право: ${key}`}
          </label>
        ))}
      {permissions.map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={value.includes(key)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, key]
                  : value.filter((item) => item !== key),
              )
            }
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
function LimitFields({
  value,
  onChange,
}: {
  value: Limits;
  onChange: (value: Limits) => void;
}) {
  return (
    <div className="sftpgo-grid">
      {(
        [
          ["quota_size", "Квота, байт"],
          ["quota_files", "Квота файлов"],
          ["max_sessions", "Одновременные подключения"],
          ["upload_bandwidth", "Скорость загрузки, КиБ/с"],
          ["download_bandwidth", "Скорость скачивания, КиБ/с"],
        ] as const
      ).map(([key, label]) => (
        <Field key={key} label={label}>
          <input
            type="number"
            min="0"
            step="1"
            required
            value={value[key]}
            onChange={(event) =>
              onChange({ ...value, [key]: Number(event.target.value) })
            }
          />
        </Field>
      ))}
      <p className="muted sftpgo-full">0 — без ограничения.</p>
    </div>
  );
}
function FolderMappings({
  base,
  value,
  acl,
  onChange,
}: {
  base: string;
  value: VirtualFolder[];
  acl: Permissions;
  onChange: (value: VirtualFolder[], permissions: Permissions) => void;
}) {
  const folders = useAPI<{ items: SharedFolder[] }>(base + "/folders");
  const aclPaths = useRef<Record<string, string>>(
    Object.fromEntries(
      value.map((mapping) => [mapping.name, mapping.virtual_path]),
    ),
  );
  function update(index: number, next: VirtualFolder) {
    const old = value[index];
    const source = aclPaths.current[old.name] || old.virtual_path;
    const rights = { ...acl };
    if (source !== next.virtual_path && validMappingPath(next.virtual_path)) {
      rights[next.virtual_path] = rights[source] || ["list", "download"];
      if (source !== "/") delete rights[source];
      aclPaths.current[next.name] = next.virtual_path;
    }
    onChange(
      value.map((item, i) => (i === index ? next : item)),
      rights,
    );
  }
  return (
    <fieldset className="sftpgo-mappings">
      <legend>Общие папки и права</legend>
      {folders.error && (
        <ErrorBox error={folders.error} retry={() => void folders.refetch()} />
      )}
      {value.map((folder, index) => (
        <div className="sftpgo-mapping" key={index}>
          <div className="sftpgo-grid">
            <Field label="Общая папка">
              <select
                required
                value={folder.name}
                onChange={(event) =>
                  update(index, { ...folder, name: event.target.value })
                }
              >
                <option value="">Выберите папку</option>
                {folders.data?.items.map((item) => (
                  <option
                    value={item.name}
                    key={item.name}
                    disabled={value.some(
                      (mapping, i) => i !== index && mapping.name === item.name,
                    )}
                  >
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Путь для пользователя">
              <input
                required
                value={folder.virtual_path}
                placeholder="/documents"
                onChange={(event) =>
                  update(index, { ...folder, virtual_path: event.target.value })
                }
              />
            </Field>
            <Field label="Квота папки, байт">
              <input
                type="number"
                min="-1"
                step="1"
                required
                value={folder.quota_size}
                onChange={(event) =>
                  update(index, {
                    ...folder,
                    quota_size: Number(event.target.value),
                  })
                }
              />
            </Field>
            <Field label="Квота файлов папки">
              <input
                type="number"
                min="-1"
                step="1"
                required
                value={folder.quota_files}
                onChange={(event) =>
                  update(index, {
                    ...folder,
                    quota_files: Number(event.target.value),
                  })
                }
              />
            </Field>
          </div>
          <PermissionFields
            title={`Права: ${folder.virtual_path || "новая папка"}`}
            disabled={!validMappingPath(folder.virtual_path)}
            value={acl[folder.virtual_path] || []}
            onChange={(rights) =>
              onChange(value, { ...acl, [folder.virtual_path]: rights })
            }
          />
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              const rights = { ...acl };
              if (folder.virtual_path !== "/")
                delete rights[
                  aclPaths.current[folder.name] || folder.virtual_path
                ];
              delete aclPaths.current[folder.name];
              onChange(
                value.filter((_, i) => i !== index),
                rights,
              );
            }}
          >
            Убрать подключение папки
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        disabled={folders.isPending || !folders.data?.items.length}
        onClick={() => {
          const folder = folders.data?.items.find(
            (item) => !value.some((mapping) => mapping.name === item.name),
          );
          if (!folder) return;
          const path = "/" + folder.name;
          onChange(
            [
              ...value,
              {
                name: folder.name,
                virtual_path: path,
                quota_size: 0,
                quota_files: 0,
              },
            ],
            { ...acl, [path]: ["list", "download"] },
          );
        }}
      >
        <Plus size={15} /> Подключить общую папку
      </Button>
      <p className="muted">
        Папка появляется по выбранному пути внутри файловой учётной записи.
        Квоты и права применяются к этому подключению. −1 — учитывать в общей
        квоте учётной записи; 0 — без отдельного ограничения папки.
      </p>
    </fieldset>
  );
}
function Confirm({
  title,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog title={title} onClose={() => !busy && onClose()}>
      <div className="actions">
        <Button disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <Button variant="destructive" disabled={busy} onClick={onConfirm}>
          {busy ? "Удаляем…" : "Удалить"}
        </Button>
      </div>
    </Dialog>
  );
}

function UsersPanel({ base }: { base: string }) {
  const users = useAPI<{ items: SFTPUser[] }>(base + "/users");
  const mutate = useActions(base);
  const [editing, setEditing] = useState<SFTPUser | "new">();
  const [deleting, setDeleting] = useState<SFTPUser>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(undefined);
    try {
      await mutate(`/users/${encodeURIComponent(deleting.username)}`, "DELETE");
      setDeleting(undefined);
      await refresh(base);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Файловые учётные записи"
      icon={<Users size={20} />}
      action={
        <Button onClick={() => setEditing("new")}>
          <Plus size={16} /> Добавить учётную запись
        </Button>
      }
    >
      <ActionFeedback error={error} />
      {users.error ? (
        <ErrorBox error={users.error} retry={() => void users.refetch()} />
      ) : users.isPending ? (
        <p role="status">Загружаем учётные записи…</p>
      ) : !users.data?.items.length ? (
        <Empty
          title="Учётных записей пока нет"
          detail="Создайте логин для SFTP и файлового браузера."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Логин</th>
                <th>Вход</th>
                <th>Группы</th>
                <th>Использовано</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((user) => (
                <tr key={user.username}>
                  <td>
                    <strong>{user.username}</strong>
                    <small>{user.description}</small>
                    <Badge value={user.enabled ? "ok" : "unknown"}>
                      {user.enabled ? "Включена" : "Отключена"}
                    </Badge>
                  </td>
                  <td>
                    {[
                      user.password_enabled && "Пароль",
                      user.public_key_enabled && "SSH-ключ",
                    ]
                      .filter(Boolean)
                      .join(" и ") || "Вход отключён"}
                  </td>
                  <td>
                    {user.groups?.map((group) => group.name).join(", ") || "—"}
                  </td>
                  <td>
                    {bytes(user.used_quota_size)} /{" "}
                    {user.quota_size ? bytes(user.quota_size) : "без квоты"}
                    <small>
                      {user.used_quota_files ?? "—"} файлов ·{" "}
                      {changedAt(user.updated_at)}
                    </small>
                  </td>
                  <td>
                    <div className="actions">
                      <Button size="sm" onClick={() => setEditing(user)}>
                        <Pencil size={14} /> Изменить
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setError(undefined);
                          setDeleting(user);
                        }}
                        aria-label={`Удалить учётную запись ${user.username}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <UserEditor
          base={base}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      {deleting && (
        <Confirm
          title={`Удалить учётную запись ${deleting.username}?`}
          busy={busy}
          onClose={() => setDeleting(undefined)}
          onConfirm={() => void remove()}
        />
      )}
    </Panel>
  );
}
function UserEditor({
  base,
  initial,
  onClose,
}: {
  base: string;
  initial?: SFTPUser;
  onClose: () => void;
}) {
  const [value, setValue] = useState<SFTPUser>(
    initial || {
      ...emptyLimits,
      username: "",
      description: "",
      enabled: true,
      password_enabled: true,
      public_key_enabled: false,
      public_keys: [],
      permissions: defaultPermissions(),
      groups: [],
      virtual_folders: [],
    },
  );
  const [password, setPassword] = useState("");
  const [keys, setKeys] = useState(initial?.public_keys.join("\n") || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [inlineError, setInlineError] = useState(true);
  const groups = useAPI<{ items: Group[] }>(base + "/groups");
  const mutate = useActions(base);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setInlineError(true);
    try {
      validateAccess(value.permissions, value.virtual_folders);
      setInlineError(false);
      const {
        has_password: _has,
        used_quota_size: _size,
        used_quota_files: _files,
        updated_at: _updated,
        ...editable
      } = value;
      await mutate(
        initial ? `/users/${encodeURIComponent(initial.username)}` : "/users",
        initial ? "PUT" : "POST",
        {
          user: {
            ...editable,
            public_keys: list(keys),
            ...(password ? { password } : {}),
          },
        },
      );
      setPassword("");
      await refresh(base);
      onClose();
    } catch (error) {
      if (
        error instanceof APIError &&
        (error.status === 400 ||
          error.status === 401 ||
          error.status === 403 ||
          error.status === 422)
      )
        setInlineError(true);
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        initial
          ? `Учётная запись ${initial.username}`
          : "Новая файловая учётная запись"
      }
      wide
      onClose={() => !busy && onClose()}
    >
      <form className="sftpgo-editor" onSubmit={(event) => void save(event)}>
        <div className="sftpgo-grid">
          <Field label="Логин SFTP">
            <input
              required
              autoComplete="off"
              disabled={!!initial}
              value={value.username}
              onChange={(event) =>
                setValue({ ...value, username: event.target.value })
              }
            />
          </Field>
          <Field label="Описание">
            <input
              value={value.description}
              onChange={(event) =>
                setValue({ ...value, description: event.target.value })
              }
            />
          </Field>
        </div>
        <label className="sftpgo-check">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) =>
              setValue({ ...value, enabled: event.target.checked })
            }
          />{" "}
          Учётная запись включена
        </label>
        <fieldset>
          <legend>Способы входа</legend>
          <div className="sftpgo-grid">
            <div>
              <label className="sftpgo-check">
                <input
                  type="checkbox"
                  checked={value.password_enabled}
                  onChange={(event) =>
                    setValue({
                      ...value,
                      password_enabled: event.target.checked,
                    })
                  }
                />{" "}
                Разрешить вход по паролю
              </label>
              <Field label={initial ? "Новый пароль" : "Пароль"}>
                <input
                  type="password"
                  required={value.password_enabled && !value.has_password}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {initial && (
                <p className="muted">Пустое поле сохраняет текущий пароль.</p>
              )}
            </div>
            <div>
              <label className="sftpgo-check">
                <input
                  type="checkbox"
                  checked={value.public_key_enabled}
                  onChange={(event) =>
                    setValue({
                      ...value,
                      public_key_enabled: event.target.checked,
                    })
                  }
                />{" "}
                Разрешить вход по SSH-ключу
              </label>
              <Field label="Публичные SSH-ключи">
                <textarea
                  rows={4}
                  value={keys}
                  onChange={(event) => setKeys(event.target.value)}
                  spellCheck={false}
                  placeholder="ssh-ed25519 …"
                />
              </Field>
              <p className="muted">Одна строка — один публичный ключ.</p>
            </div>
          </div>
        </fieldset>
        <fieldset>
          <legend>Группы</legend>
          {groups.error ? (
            <ErrorBox
              error={groups.error}
              retry={() => void groups.refetch()}
            />
          ) : groups.isPending ? (
            <p>Загружаем группы…</p>
          ) : !groups.data?.items.length ? (
            <p className="muted">Групп пока нет.</p>
          ) : (
            groups.data.items.map((group) => {
              const membership = value.groups.find(
                (item) => item.name === group.name,
              );
              return (
                <div className="sftpgo-membership" key={group.name}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!membership}
                      onChange={(event) =>
                        setValue({
                          ...value,
                          groups: event.target.checked
                            ? [...value.groups, { name: group.name, type: 2 }]
                            : value.groups.filter(
                                (item) => item.name !== group.name,
                              ),
                        })
                      }
                    />
                    {group.name}
                  </label>
                  {membership && (
                    <select
                      aria-label={`Роль в группе ${group.name}`}
                      value={membership.type}
                      onChange={(event) =>
                        setValue({
                          ...value,
                          groups: value.groups.map((item) =>
                            item.name === group.name
                              ? {
                                  ...item,
                                  type: Number(event.target.value) as 1 | 2 | 3,
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value={1}>Основная</option>
                      <option value={2}>Дополнительная</option>
                      <option value={3}>Членство</option>
                    </select>
                  )}
                </div>
              );
            })
          )}
        </fieldset>
        <PermissionFields
          value={value.permissions["/"] || []}
          onChange={(rights) =>
            setValue({
              ...value,
              permissions: { ...value.permissions, "/": rights },
            })
          }
        />
        <LimitFields
          value={value}
          onChange={(limits) => setValue({ ...value, ...limits })}
        />
        <FolderMappings
          base={base}
          value={value.virtual_folders}
          acl={value.permissions}
          onChange={(virtual_folders, permissions) =>
            setValue({ ...value, virtual_folders, permissions })
          }
        />
        <ActionFeedback error={!inlineError ? error : undefined} />
        {inlineError && Boolean(error) && <ErrorBox error={error} />}
        <div className="actions">
          <Button disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" variant="default" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить учётную запись"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function GroupsPanel({ base }: { base: string }) {
  const groups = useAPI<{ items: Group[] }>(base + "/groups");
  const [editing, setEditing] = useState<Group | "new">();
  const [deleting, setDeleting] = useState<Group>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const mutate = useActions(base);
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(undefined);
    try {
      await mutate(`/groups/${encodeURIComponent(deleting.name)}`, "DELETE");
      setDeleting(undefined);
      await refresh(base);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Группы доступа"
      icon={<Users size={20} />}
      action={
        <Button onClick={() => setEditing("new")}>
          <Plus size={16} /> Создать группу
        </Button>
      }
    >
      <p className="muted">
        Группа объединяет права, общие папки и ограничения для нескольких
        учётных записей.
      </p>
      <ActionFeedback error={error} />
      {groups.error ? (
        <ErrorBox error={groups.error} retry={() => void groups.refetch()} />
      ) : groups.isPending ? (
        <p role="status">Загружаем группы…</p>
      ) : !groups.data?.items.length ? (
        <Empty title="Групп пока нет" />
      ) : (
        <div className="sftpgo-list">
          {groups.data.items.map((group) => (
            <div className="sftpgo-list-row" key={group.name}>
              <div>
                <strong>{group.name}</strong>
                <p className="muted">
                  {group.description || "Без описания"} ·{" "}
                  {group.virtual_folders.length} общих папок
                </p>
              </div>
              <div className="actions">
                <Button size="sm" onClick={() => setEditing(group)}>
                  Изменить
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setError(undefined);
                    setDeleting(group);
                  }}
                >
                  Удалить
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <GroupEditor
          base={base}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      {deleting && (
        <Confirm
          title={`Удалить группу ${deleting.name}?`}
          busy={busy}
          onClose={() => setDeleting(undefined)}
          onConfirm={() => void remove()}
        />
      )}
    </Panel>
  );
}
function GroupEditor({
  base,
  initial,
  onClose,
}: {
  base: string;
  initial?: Group;
  onClose: () => void;
}) {
  const [value, setValue] = useState<Group>(
    initial || {
      ...emptyLimits,
      name: "",
      description: "",
      permissions: defaultPermissions(),
      virtual_folders: [],
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [inlineError, setInlineError] = useState(true);
  const mutate = useActions(base);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setInlineError(true);
    try {
      validateAccess(value.permissions, value.virtual_folders);
      setInlineError(false);
      await mutate(
        initial ? `/groups/${encodeURIComponent(initial.name)}` : "/groups",
        initial ? "PUT" : "POST",
        { group: value },
      );
      await refresh(base);
      onClose();
    } catch (error) {
      if (
        error instanceof APIError &&
        (error.status === 400 ||
          error.status === 401 ||
          error.status === 403 ||
          error.status === 422)
      )
        setInlineError(true);
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={initial ? `Группа ${initial.name}` : "Новая группа"}
      wide
      onClose={() => !busy && onClose()}
    >
      <form className="sftpgo-editor" onSubmit={(event) => void save(event)}>
        <div className="sftpgo-grid">
          <Field label="Название группы">
            <input
              required
              disabled={!!initial}
              value={value.name}
              onChange={(event) =>
                setValue({ ...value, name: event.target.value })
              }
            />
          </Field>
          <Field label="Описание">
            <input
              value={value.description}
              onChange={(event) =>
                setValue({ ...value, description: event.target.value })
              }
            />
          </Field>
        </div>
        <PermissionFields
          value={value.permissions["/"] || []}
          onChange={(rights) =>
            setValue({
              ...value,
              permissions: { ...value.permissions, "/": rights },
            })
          }
        />
        <LimitFields
          value={value}
          onChange={(limits) => setValue({ ...value, ...limits })}
        />
        <FolderMappings
          base={base}
          value={value.virtual_folders}
          acl={value.permissions}
          onChange={(virtual_folders, permissions) =>
            setValue({ ...value, virtual_folders, permissions })
          }
        />
        <ActionFeedback error={!inlineError ? error : undefined} />
        {inlineError && Boolean(error) && <ErrorBox error={error} />}
        <div className="actions">
          <Button disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" variant="default" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить группу"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function FoldersPanel({ base }: { base: string }) {
  const folders = useAPI<{ items: SharedFolder[] }>(base + "/folders");
  const [editing, setEditing] = useState<SharedFolder | "new">();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deleting, setDeleting] = useState<SharedFolder>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const mutate = useActions(base);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await mutate(
        editing === "new" ? "/folders" : `/folders/${encodeURIComponent(name)}`,
        editing === "new" ? "POST" : "PUT",
        { folder: { name, description } },
      );
      setEditing(undefined);
      await refresh(base);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(undefined);
    try {
      await mutate(`/folders/${encodeURIComponent(deleting.name)}`, "DELETE");
      setDeleting(undefined);
      await refresh(base);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Общие папки"
      icon={<Folder size={20} />}
      action={
        <Button
          onClick={() => {
            setName("");
            setDescription("");
            setError(undefined);
            setEditing("new");
          }}
        >
          <Plus size={16} /> Создать общую папку
        </Button>
      }
    >
      <p className="muted">
        Создайте папку, затем подключите её к группе или учётной записи: там
        задаются путь, квота и права доступа.
      </p>
      <ActionFeedback error={error} />
      {folders.error ? (
        <ErrorBox error={folders.error} retry={() => void folders.refetch()} />
      ) : folders.isPending ? (
        <p role="status">Загружаем папки…</p>
      ) : !folders.data?.items.length ? (
        <Empty title="Общих папок пока нет" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Использовано</th>
                <th>Учётные записи</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {folders.data.items.map((folder) => (
                <tr key={folder.name}>
                  <td>
                    <strong>{folder.name}</strong>
                    <small>{folder.description}</small>
                  </td>
                  <td>
                    {bytes(folder.used_quota_size)}
                    <small>{folder.used_quota_files ?? "—"} файлов</small>
                  </td>
                  <td>{folder.users?.join(", ") || "—"}</td>
                  <td>
                    <div className="actions">
                      <Button
                        size="sm"
                        onClick={() => {
                          setName(folder.name);
                          setDescription(folder.description);
                          setError(undefined);
                          setEditing(folder);
                        }}
                      >
                        Изменить
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setError(undefined);
                          setDeleting(folder);
                        }}
                      >
                        Удалить
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Dialog
          title={editing === "new" ? "Новая общая папка" : `Папка ${name}`}
          onClose={() => !busy && setEditing(undefined)}
        >
          <form
            className="sftpgo-editor"
            onSubmit={(event) => void save(event)}
          >
            <Field label="Название папки">
              <input
                required
                disabled={editing !== "new"}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Описание">
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <div className="actions">
              <Button disabled={busy} onClick={() => setEditing(undefined)}>
                Отмена
              </Button>
              <Button type="submit" variant="default" disabled={busy}>
                Сохранить папку
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {deleting && (
        <Confirm
          title={`Удалить общую папку ${deleting.name}?`}
          busy={busy}
          onClose={() => setDeleting(undefined)}
          onConfirm={() => void remove()}
        />
      )}
    </Panel>
  );
}

function SettingsPanel({ base }: { base: string }) {
  const settings = useAPI<Configuration>(base + "/settings");
  if (settings.error)
    return (
      <ErrorBox error={settings.error} retry={() => void settings.refetch()} />
    );
  if (!settings.data)
    return <p role="status">Загружаем настройки подключения…</p>;
  return (
    <SettingsEditor
      key={settings.data.revision}
      base={base}
      initial={settings.data}
    />
  );
}
function SettingsEditor({
  base,
  initial,
}: {
  base: string;
  initial: Configuration;
}) {
  const [address, setAddress] = useState(initial.listen_ip);
  const [port, setPort] = useState(initial.port);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [jobID, setJobID] = useState("");
  const handledJob = useRef("");
  const mutate = useActions(base);
  const job = useQuery({
    queryKey: [`/jobs/${jobID}`],
    queryFn: ({ signal }) =>
      api<Job>(`/jobs/${jobID}`, "GET", undefined, {}, signal),
    enabled: !!jobID,
    refetchInterval: (query) =>
      !query.state.data ||
      ["queued", "pending", "running"].includes(query.state.data.status)
        ? 2000
        : false,
    retry: false,
  });
  const pending =
    busy ||
    (!!jobID &&
      (!job.data ||
        ["queued", "pending", "running"].includes(job.data.status)));
  useEffect(() => {
    if (
      !job.data ||
      handledJob.current === job.data.id ||
      !["succeeded", "failed", "unknown"].includes(job.data.status)
    )
      return;
    handledJob.current = job.data.id;
    if (job.data.status === "succeeded") {
      setNotice("Настройки подключения применены.");
      void refresh(base);
      void queryClient.invalidateQueries({ queryKey: ["/modules"] });
    } else {
      setError(
        new Error(
          job.data.error ||
            (job.data.status === "unknown"
              ? "Результат применения не подтверждён. Проверьте состояние модуля перед повтором."
              : "Не удалось применить настройки подключения."),
        ),
      );
      void refresh(base);
    }
  }, [job.data, base]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const result = await mutate<{ job: Job }>("/settings", "POST", {
        configuration: { listen_ip: address, port },
        expected_revision: initial.revision,
      });
      if (!result?.job?.id)
        throw new Error(
          "Задание не подтверждено. Проверьте состояние модуля перед повтором.",
        );
      queryClient.setQueryData([`/jobs/${result.job.id}`], result.job);
      setJobID(result.job.id);
      setNotice("Изменение настроек принято. Ожидаем применения…");
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Подключение по SFTP" icon={<KeyRound size={20} />}>
      <form className="sftpgo-editor" onSubmit={(event) => void save(event)}>
        <p className="muted">
          Веб-интерфейс работает через PL. Для SFTP-клиентов задайте адрес этого
          хоста и отдельный порт.
        </p>
        <div className="sftpgo-grid">
          <Field label="IPv4 для SFTP">
            <input
              required
              disabled={pending}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="Порт SFTP">
            <input
              required
              disabled={pending}
              type="number"
              min="1"
              max="65535"
              step="1"
              value={port}
              onChange={(event) => setPort(Number(event.target.value))}
            />
          </Field>
        </div>
        <p className="muted">
          127.0.0.1 доступен только с самого хоста. Для подключения из сети
          укажите его частный IPv4. Изменение прерывает активные
          SFTP-подключения.
        </p>
        <ActionFeedback
          notice={notice}
          error={error}
          noticeKind={pending ? "info" : "success"}
        />
        {job.error && (
          <ErrorBox error={job.error} retry={() => void job.refetch()} />
        )}
        <Button
          variant="default"
          type="submit"
          disabled={
            pending || (address === initial.listen_ip && port === initial.port)
          }
        >
          {pending ? "Применяем настройки…" : "Применить настройки подключения"}
        </Button>
      </form>
    </Panel>
  );
}

function FileBrowser({
  base,
  authenticated,
  username,
  statusLoading,
}: {
  base: string;
  authenticated: boolean;
  username?: string;
  statusLoading: boolean;
}) {
  const [path, setPath] = useState("/");
  const [reauthenticationRequired, setReauthenticationRequired] =
    useState(false);
  const fileAuthenticated = authenticated && !reauthenticationRequired;
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [inlineError, setInlineError] = useState(false);
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<{
    kind: "mkdir" | "rename" | "delete";
    entry?: FileEntry;
  }>();
  const [name, setName] = useState("");
  const [pendingUpload, setPendingUpload] = useState<File>();
  const session = useAPI<{ csrf_token?: string }>("/session");
  const mutate = useActions(base);
  const files = useAPI<FileListing>(
    `${base}/files?${new URLSearchParams({ path })}`,
    fileAuthenticated,
  );
  const uploadIntent = useRef<{ signature: string; key: string } | undefined>(
    undefined,
  );
  const expireFileSession = useCallback(
    (reason: unknown) => {
      if (!nativeAuthenticationError(reason)) return;
      setReauthenticationRequired(true);
      setPath("/");
      setPassword("");
      setOperation(undefined);
      setPendingUpload(undefined);
      setNotice("");
      setError(friendly(reason));
      uploadIntent.current = undefined;
      const privateFiles = (query: { queryKey: readonly unknown[] }) =>
        typeof query.queryKey[0] === "string" &&
        query.queryKey[0].startsWith(base + "/files");
      // Remove private file data immediately, then cancel requests that might
      // otherwise repopulate a retired native account's cache.
      queryClient.removeQueries({ predicate: privateFiles });
      void queryClient.cancelQueries({ predicate: privateFiles });
      queryClient.setQueryData<Status>([base + "/status"], (previous) =>
        previous
          ? {
              ...previous,
              client_authenticated: false,
              client_username: undefined,
            }
          : previous,
      );
    },
    [base],
  );
  useEffect(() => {
    if (files.error) expireFileSession(files.error);
  }, [files.error, expireFileSession]);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setInlineError(false);
    setError(undefined);
    try {
      await mutate("/client/login", "POST", { username: login, password });
      setReauthenticationRequired(false);
      setNotice("");
      setPassword("");
      setPath("/");
      queryClient.removeQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === "string" &&
          query.queryKey[0].startsWith(base + "/files"),
      });
      await refresh(base);
    } catch (error) {
      expireFileSession(error);
      setError(friendly(error));
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    setInlineError(false);
    setError(undefined);
    try {
      await mutate("/client/logout", "POST", {});
      setReauthenticationRequired(true);
      setPassword("");
      setPath("/");
      queryClient.removeQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === "string" &&
          query.queryKey[0].startsWith(base + "/files"),
      });
      await refresh(base);
    } catch (error) {
      expireFileSession(error);
      setError(friendly(error));
    } finally {
      setBusy(false);
    }
  }
  async function fileError(response: Response) {
    let message = `Файловый сервер вернул ошибку ${response.status}.`;
    let code = "";
    try {
      const data = await response.json();
      if (typeof data.message === "string") message = data.message;
      else if (typeof data.error === "string") message = data.error;
      code =
        typeof data.error === "string"
          ? data.error
          : data.error?.code || data.code || "";
      if (typeof data.error?.message === "string") message = data.error.message;
    } catch {
      /* response has no public error */
    }
    throw new APIError(message, response.status, code);
  }
  async function upload(file: File) {
    setBusy(true);
    setInlineError(false);
    setError(undefined);
    setNotice("");
    const destination = childPath(path, file.name);
    const signature = JSON.stringify([
      destination,
      file.size,
      file.lastModified,
    ]);
    if (uploadIntent.current?.signature !== signature)
      uploadIntent.current = { signature, key: crypto.randomUUID() };
    try {
      if (!session.data?.csrf_token)
        throw new Error("Не удалось подтвердить сессию PL. Обновите страницу.");
      const response = await fetch(
        `/api/v1${base}/files/content?${new URLSearchParams({ path: destination })}`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-CSRF-Token": session.data.csrf_token,
            "Idempotency-Key": uploadIntent.current.key,
          },
          body: file,
        },
      );
      if (!response.ok) await fileError(response);
      uploadIntent.current = undefined;
      setNotice(`Файл «${file.name}» загружен.`);
      await files.refetch();
    } catch (error) {
      expireFileSession(error);
      setError(friendly(error));
    } finally {
      setBusy(false);
    }
  }
  async function download(entry: FileEntry) {
    setBusy(true);
    setInlineError(false);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/v1${base}/files/content?${new URLSearchParams({ path: childPath(path, entry.name) })}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) await fileError(response);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = entry.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      expireFileSession(error);
      setError(friendly(error));
    } finally {
      setBusy(false);
    }
  }
  async function apply(event?: FormEvent) {
    event?.preventDefault();
    if (!operation) return;
    setInlineError(true);
    if (
      operation.kind !== "delete" &&
      (!name ||
        name === "." ||
        name === ".." ||
        /[/\\\x00-\x1f\x7f]/.test(name))
    ) {
      setError(new Error("Укажите имя без разделителей пути."));
      return;
    }
    setBusy(true);
    setInlineError(false);
    setError(undefined);
    try {
      if (operation.kind === "mkdir")
        await mutate("/files/directory", "POST", {
          path: childPath(path, name),
        });
      else if (operation.kind === "rename" && operation.entry)
        await mutate("/files/rename", "POST", {
          source: childPath(path, operation.entry.name),
          target: childPath(path, name),
        });
      else if (operation.kind === "delete" && operation.entry)
        await mutate(
          `/files?${new URLSearchParams({ path: childPath(path, operation.entry.name), directory: String(operation.entry.type === "dir") })}`,
          "DELETE",
        );
      setOperation(undefined);
      await files.refetch();
    } catch (error) {
      expireFileSession(error);
      setError(friendly(error));
    } finally {
      setBusy(false);
    }
  }
  const crumbs = path.split("/").filter(Boolean);
  if (!fileAuthenticated)
    return (
      <Panel title="Вход в файлы" icon={<KeyRound size={20} />}>
        <p className="muted">
          Введите логин и пароль файловой учётной записи SFTPGo. Этот вход не
          меняет вашу учётную запись PL.
        </p>
        <form className="sftpgo-login" onSubmit={(event) => void signIn(event)}>
          <Field label="Логин файловой учётной записи">
            <input
              required
              autoComplete="username"
              value={login}
              disabled={busy || statusLoading}
              onChange={(event) => setLogin(event.target.value)}
            />
          </Field>
          <Field label="Пароль файловой учётной записи">
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy || statusLoading}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button
            variant="default"
            type="submit"
            disabled={busy || statusLoading}
          >
            {busy ? "Входим…" : "Открыть файлы"}
          </Button>
        </form>
        <p className="muted">
          Вход по SSH-ключу доступен в SFTP-клиенте. Веб-браузер использует
          пароль.
        </p>
        {Boolean(error) && <ErrorBox error={friendly(error)} />}
      </Panel>
    );
  return (
    <Panel
      title="Файлы"
      icon={<Folder size={20} />}
      action={
        <Button disabled={busy} onClick={() => void signOut()}>
          <LogOut size={16} /> Выйти из файлов
        </Button>
      }
    >
      <div className="sftpgo-file-toolbar">
        <nav className="sftpgo-breadcrumbs" aria-label="Текущая папка">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setPath("/");
              setInlineError(false);
              setError(undefined);
            }}
          >
            Корень
          </Button>
          {crumbs.map((part, index) => (
            <Button
              size="sm"
              variant="ghost"
              key={index}
              disabled={busy}
              onClick={() => {
                setPath("/" + crumbs.slice(0, index + 1).join("/"));
                setInlineError(false);
                setError(undefined);
              }}
            >
              {part}
            </Button>
          ))}
        </nav>
        <span className="muted">{username || "Файловая сессия"}</span>
        <div className="actions">
          <Button
            disabled={busy}
            onClick={() => {
              setName("");
              setInlineError(false);
              setError(undefined);
              setOperation({ kind: "mkdir" });
            }}
          >
            <FolderPlus size={16} /> Новая папка
          </Button>
          <label className={`sftpgo-upload ${busy ? "is-disabled" : ""}`}>
            <Upload size={16} /> Загрузить файл
            <input
              aria-label="Загрузить файл"
              type="file"
              disabled={
                busy ||
                !session.data?.csrf_token ||
                !files.data ||
                !!files.error
              }
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  const existing = files.data?.entries.find(
                    (entry) => entry.name === file.name,
                  );
                  if (existing?.type === "dir") {
                    setInlineError(true);
                    setError(new Error("Папка с таким именем уже существует."));
                  } else if (existing) setPendingUpload(file);
                  else void upload(file);
                }
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      <p className="muted">
        Доступные действия определяются правами файловой учётной записи.
      </p>
      <ActionFeedback
        notice={notice}
        error={!inlineError ? error : undefined}
      />
      {!operation && inlineError && Boolean(error) && (
        <ErrorBox error={error} />
      )}
      {files.error ? (
        <ErrorBox
          error={friendly(files.error)}
          retry={() => void files.refetch()}
        />
      ) : files.isPending ? (
        <p role="status">Читаем папку…</p>
      ) : !files.data?.entries.length ? (
        <Empty title="Папка пуста" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Размер</th>
                <th>Изменён</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {files.data.entries.map((entry) => (
                <tr key={entry.name}>
                  <td>
                    {entry.type === "dir" ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setPath(childPath(path, entry.name));
                          setInlineError(false);
                          setError(undefined);
                        }}
                      >
                        <Folder size={16} /> {entry.name}
                      </Button>
                    ) : (
                      <span>{entry.name}</span>
                    )}
                  </td>
                  <td>{entry.type === "dir" ? "Папка" : bytes(entry.size)}</td>
                  <td>{changedAt(entry.modified_at)}</td>
                  <td>
                    <div className="actions">
                      {entry.type === "file" && (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void download(entry)}
                          aria-label={`Скачать ${entry.name}`}
                        >
                          <Download size={15} />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={busy}
                        aria-label={`Переименовать ${entry.name}`}
                        onClick={() => {
                          setName(entry.name);
                          setInlineError(false);
                          setError(undefined);
                          setOperation({ kind: "rename", entry });
                        }}
                      >
                        <Pencil size={15} />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        aria-label={`Удалить ${entry.name}`}
                        onClick={() => {
                          setInlineError(false);
                          setError(undefined);
                          setOperation({ kind: "delete", entry });
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pendingUpload && (
        <Dialog
          title={`Заменить файл «${pendingUpload.name}»?`}
          onClose={() => !busy && setPendingUpload(undefined)}
        >
          <p>
            Файл с таким именем уже есть в открытой папке. Загрузить новую
            версию?
          </p>
          <div className="actions">
            <Button onClick={() => setPendingUpload(undefined)}>Отмена</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const file = pendingUpload;
                setPendingUpload(undefined);
                void upload(file);
              }}
            >
              Заменить файл
            </Button>
          </div>
        </Dialog>
      )}
      {operation?.kind === "delete" && (
        <Dialog
          title={`Удалить «${operation.entry?.name}»?`}
          onClose={() => !busy && setOperation(undefined)}
        >
          <p>
            {operation.entry?.type === "dir"
              ? "Каталог и всё его содержимое будут удалены."
              : "Файл будет удалён."}{" "}
            Действие выполняется с правами текущей файловой учётной записи.
          </p>
          {inlineError && Boolean(error) && <ErrorBox error={error} />}
          <div className="actions">
            <Button disabled={busy} onClick={() => setOperation(undefined)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy ? "Удаляем…" : "Удалить"}
            </Button>
          </div>
        </Dialog>
      )}
      {operation && operation.kind !== "delete" && (
        <Dialog
          title={operation.kind === "mkdir" ? "Новая папка" : "Переименовать"}
          onClose={() => !busy && setOperation(undefined)}
        >
          <form
            className="sftpgo-editor"
            onSubmit={(event) => void apply(event)}
          >
            <Field label="Название">
              <input
                required
                pattern="[^/\\\\]+"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            {inlineError && Boolean(error) && <ErrorBox error={error} />}
            <div className="actions">
              <Button disabled={busy} onClick={() => setOperation(undefined)}>
                Отмена
              </Button>
              <Button type="submit" variant="default" disabled={busy}>
                Сохранить
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </Panel>
  );
}
