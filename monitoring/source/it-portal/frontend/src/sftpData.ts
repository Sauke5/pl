export type SFTPCollection = {
  id: string;
  revision: number;
  branch: string;
  label: string;
  folder: string;
  quota_bytes: number;
  created_at: string;
  reader_ids: string[];
  last_applied_at?: string | null;
  provisioning_state?: string;
  provisioning_error?: string;
};
export type SFTPAccountKind = "sender" | "receiver";
export type SFTPAccount = {
  kind: SFTPAccountKind;
  id: string;
  revision: number;
  username: string;
  label: string;
  collection_ids: string[];
  quota_bytes: number;
  enabled: boolean;
  provisioning_state: string;
  provisioning_error?: string;
  last_applied_at?: string | null;
  permissions: string[];
  public_keys: string[];
};
export type SFTPVersion = {
  id: string;
  collection_id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  received_at: string;
  received_by: string;
  received_by_name?: string;
  is_new: boolean;
  source: string;
  can_download: boolean;
  can_delete?: boolean;
  deletion_state?: "" | "pending" | "deleted" | "failed" | "uncertain";
  deleted_at?: string | null;
  deleted_by?: string;
};
export type SFTPAudit = {
  id: string;
  action: string;
  actor: string;
  actor_name?: string;
  occurred_at: string;
  collection_id?: string;
  version_id?: string;
};
export type SFTPReader = { id: string; name: string };
export type SFTPState = {
  mode: string;
  provider?: {
    configured: boolean;
    quarantined_receipts?: number;
    status: "disabled" | "healthy" | "error" | "stale";
    last_attempt_at: string | null;
    last_success_at: string | null;
    error: string;
  };
  sftp_connected: boolean;
  demo_upload_enabled: boolean;
  can_manage: boolean;
  retention_months: number;
  versions_total?: number;
  versions_limit?: number;
  versions_has_more?: boolean;
  audit_total?: number;
  audit_limit?: number;
  retention_enforced?: boolean;
  collections: SFTPCollection[];
  accounts: SFTPAccount[];
  available_readers?: SFTPReader[];
  versions: SFTPVersion[];
  audit: SFTPAudit[];
};
export function bytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  const units = ["КиБ", "МиБ", "ГиБ", "ТиБ"];
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length,
  );
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value / 1024 ** exponent)} ${units[exponent - 1]}`;
}
export function orderedVersions(
  versions: SFTPVersion[],
  collection: string,
  query: string,
  onlyNew: boolean,
  includeDeleted = false,
): SFTPVersion[] {
  const normalized = query.trim().toLocaleLowerCase("ru");
  return versions
    .filter(
      (v) =>
        (includeDeleted || !isDeletedVersion(v)) &&
        (!collection || v.collection_id === collection) &&
        (!onlyNew || (v.is_new && !isDeletedVersion(v))) &&
        (!normalized ||
          `${v.filename} ${v.received_by_name || v.received_by}`
            .toLocaleLowerCase("ru")
            .includes(normalized)),
    )
    .sort(
      (a, b) =>
        b.received_at.localeCompare(a.received_at) || b.id.localeCompare(a.id),
    );
}
export const auditLabels: Record<string, string> = {
  "file.delete.requested": "Запрошено удаление с SFTP",
  "file.delete.deleted": "Файл удалён с SFTP",
  "file.delete.failed": "Ошибка удаления с SFTP",
  "file.delete.uncertain": "Удаление с SFTP не подтверждено",
  "file.delete.denied": "Отказано в удалении с SFTP",
  "provisioning.applied": "Настройки применены в SFTPGo",
  "provisioning.failed": "Ошибка применения настроек",
  "download.completed": "Архив передан клиенту",
  "download.failed": "Ошибка передачи архива",
  "panel.open": "Вход в сервис",
  "collection.saved": "Сохранён каталог",
  "account.policy_saved": "Настроены права учётной записи",
  "version.received": "Получен архив",
  "upload.duplicate": "Повторная загрузка архива",
  "receipt.quarantined": "Событие загрузки изолировано",
  "download.requested": "Запрошено скачивание архива",
  "download.started": "Начато скачивание архива",
  "download.denied": "Отказано в скачивании",
  module_access: "Вход в сервис",
  access: "Вход в сервис",
  collection_created: "Создан каталог",
  account_created: "Создана учётная запись",
  account_updated: "Изменена учётная запись",
  version_seen: "Просмотрена версия",
  test_upload: "Загружен тестовый архив",
  version_download: "Скачан архив",
};

export function readerOptions(
  available: SFTPReader[],
  granted: string[],
): SFTPReader[] {
  let previous = 0;
  const readers = new Map(
    available.map((reader) => [
      reader.id,
      reader.name && reader.name !== reader.id
        ? reader
        : { id: reader.id, name: `Ранее выданный доступ ${++previous}` },
    ]),
  );
  for (const id of granted) {
    if (!readers.has(id)) {
      previous++;
      readers.set(id, { id, name: `Ранее выданный доступ ${previous}` });
    }
  }
  return [...readers.values()];
}

/** Never submit private key material to the control plane, including on validation errors. */
export function publicKeyLines(value: string, required = true): string[] {
  if (/PRIVATE[\s_-]*KEY/i.test(value) || /-----BEGIN/.test(value)) {
    throw new Error(
      "Нужен только публичный SSH-ключ из файла .pub. Закрытый ключ сюда вставлять нельзя.",
    );
  }
  const keys = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (required && !keys.length)
    throw new Error("Добавьте хотя бы один публичный SSH-ключ.");
  if (
    keys.some(
      (key) =>
        !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: .*)?$/.test(
          key,
        ),
    )
  ) {
    throw new Error(
      "Каждый публичный SSH-ключ должен занимать одну строку в формате OpenSSH.",
    );
  }
  return [...new Set(keys)];
}

export function provisioningLabel(state?: string): string {
  return (
    (
      {
        applied: "Применено",
        pending: "Не применено",
        error: "Ошибка применения",
        conflict: "Конфликт настройки",
      } as Record<string, string>
    )[state || ""] || "Нет подтверждения"
  );
}
export function providerLabel(status?: string): string {
  return (
    (
      {
        healthy: "SFTPGo доступен",
        disabled: "SFTPGo не подключён",
        error: "Требуется проверка SFTPGo",
        stale: "Данные SFTPGo устарели",
      } as Record<string, string>
    )[status || ""] || "Состояние SFTPGo неизвестно"
  );
}

export function minimumAccountQuota(
  collections: SFTPCollection[],
  selected: string[],
): number {
  const ids = new Set(selected);
  return collections.reduce(
    (total, collection) =>
      total + (ids.has(collection.id) ? collection.quota_bytes : 0),
    0,
  );
}

export function provisioningReason(code?: string): string {
  const reasons: Record<string, string> = {
    provider_auth_denied:
      "SFTPGo отклонил доступ Платформы. Требуется проверить серверную интеграцию.",
    provider_unavailable:
      "Не удалось связаться с SFTPGo. Повторите проверку связи.",
    provider_error:
      "SFTPGo вернул ошибку. Повторите применение после проверки сервера.",
    provider_readback_mismatch:
      "Проверка SFTPGo не подтвердила сохранённые настройки.",
    ownership_conflict:
      "В SFTPGo уже существует объект с таким именем, созданный вне этого сервиса.",
    credential_unavailable:
      "Серверный доступ к SFTPGo не настроен или недоступен.",
    invalid_policy:
      "SFTPGo не принял настройки доступа. Проверьте ключи, папки и квоты.",
    unconfirmed_files:
      "Не все файлы подтверждены источником. Обновление архива требует проверки.",
    event_integrity_error:
      "Событие загрузки не прошло проверку целостности. Файл не включён в архив; остальные загрузки обрабатываются.",
    event_path_conflict:
      "Для уже принятого имени файла получено другое событие загрузки. Спорная версия не включена в архив.",
    quarantined_receipts:
      "Есть изолированные события загрузки. Их файлы не включены в архив; остальные загрузки обрабатываются.",
    dependent_account_error:
      "Настройки каталога зависят от отправителя, для которого применение завершилось ошибкой.",
    account_not_verified: "Учётная запись ещё не подтверждена на SFTPGo.",
  };
  return code
    ? reasons[code] || "Ошибка не распознана. Проверьте серверную интеграцию."
    : "Проверьте настройки и повторите применение.";
}

export function accountQuotaBytes(
  kind: SFTPAccountKind,
  gib: number,
  collections: SFTPCollection[],
  assigned: string[],
): number {
  if (kind === "receiver") return 0;
  const quota = gib * 1024 ** 3;
  if (!Number.isSafeInteger(quota) || quota <= 0)
    throw new Error("Укажите положительную квоту пользователя.");
  if (quota < minimumAccountQuota(collections, assigned))
    throw new Error(
      "Квота пользователя должна быть не меньше суммы квот выбранных каталогов.",
    );
  return quota;
}
export function accountKindLabel(kind?: string): string {
  return kind === "receiver"
    ? "Получатель"
    : kind === "sender" || kind === undefined
      ? "Отправитель"
      : "Неизвестный тип";
}

export function isDeletedVersion(version: SFTPVersion): boolean {
  return version.deletion_state === "deleted";
}
export function versionCanDownload(version: SFTPVersion): boolean {
  return (
    version.can_download &&
    !["pending", "deleted", "uncertain"].includes(version.deletion_state || "")
  );
}
export function deletionLabel(state?: string): string {
  return (
    (
      {
        deleted: "Удалён с SFTP",
        pending: "Удаление выполняется",
        failed: "Ошибка удаления",
        uncertain: "Удаление не подтверждено",
      } as Record<string, string>
    )[state || ""] || ""
  );
}
export function versionSummary(versions: SFTPVersion[]): {
  newCount: number;
  totalBytes: number;
} {
  return versions.reduce(
    (total, version) =>
      isDeletedVersion(version)
        ? total
        : {
            newCount: total.newCount + (version.is_new ? 1 : 0),
            totalBytes: total.totalBytes + version.size_bytes,
          },
    { newCount: 0, totalBytes: 0 },
  );
}
export function confirmedDeletedVersion(
  version: SFTPVersion,
  response: unknown,
): SFTPVersion {
  if (!response || typeof response !== "object")
    throw new Error("delete_unconfirmed");
  const result = response as Record<string, unknown>;
  if (
    result.status !== "deleted" ||
    typeof result.deleted_at !== "string" ||
    !Number.isFinite(Date.parse(result.deleted_at)) ||
    typeof result.deleted_by !== "string" ||
    !result.deleted_by.trim()
  )
    throw new Error("delete_unconfirmed");
  return {
    ...version,
    deletion_state: "deleted",
    deleted_at: result.deleted_at,
    deleted_by: result.deleted_by,
    can_delete: false,
    can_download: false,
    is_new: false,
  };
}

export function needsDeletionCheck(version: SFTPVersion): boolean {
  return (
    version.deletion_state === "pending" ||
    version.deletion_state === "uncertain"
  );
}
