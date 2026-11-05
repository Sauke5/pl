import assert from "node:assert/strict";
import test from "node:test";
import {
  bytes,
  orderedVersions,
  readerOptions,
  publicKeyLines,
  provisioningLabel,
  providerLabel,
  minimumAccountQuota,
  provisioningReason,
  accountQuotaBytes,
  accountKindLabel,
  confirmedDeletedVersion,
  isDeletedVersion,
  versionCanDownload,
  versionSummary,
  type SFTPVersion,
} from "../../src/sftpData.ts";
const version = (
  id: string,
  folder: string,
  received: string,
  isNew: boolean,
  filename = "База.zip",
): SFTPVersion => ({
  id,
  collection_id: folder,
  received_at: received,
  is_new: isNew,
  filename,
  received_by: "Тестовый отправитель",
  sha256: "a".repeat(64),
  size_bytes: 1024,
  source: "test",
  can_download: false,
});
test("filters by explicit folder and per-user unread flag without mutating source", () => {
  const input = [
    version("1", "a", "2026-10-19T10:00:00Z", true),
    version("2", "b", "2026-10-20T10:00:00Z", true),
    version("3", "a", "2026-10-20T10:00:00Z", false),
  ];
  assert.deepEqual(
    orderedVersions(input, "a", "", true).map((v) => v.id),
    ["1"],
  );
  assert.deepEqual(
    orderedVersions(input, "", "", false).map((v) => v.id),
    ["3", "2", "1"],
  );
  assert.deepEqual(
    input.map((v) => v.id),
    ["1", "2", "3"],
  );
});
test("search handles Russian case and whitespace; does not hide unchanged-content versions", () => {
  const input = [
    version("1", "a", "2026-10-19T10:00:00Z", false),
    version("2", "a", "2026-10-20T10:00:00Z", true),
  ];
  assert.equal(orderedVersions(input, "", " БАЗА ", false).length, 2);
  assert.equal(orderedVersions(input, "", "ОТПРАВИТЕЛЬ", false).length, 2);
  assert.equal(orderedVersions(input, "", "нет совпадений", false).length, 0);
});
test("formats compressed archive byte sizes in IEC units", () => {
  assert.equal(bytes(0), "0 Б");
  assert.equal(bytes(1024), "1 КиБ");
  assert.equal(bytes(1024 ** 3), "1 ГиБ");
  assert.equal(bytes(1536), "1,5 КиБ");
});

test("reader choices retain existing grants absent from active sessions without exposing raw identities", () => {
  assert.deepEqual(
    readerOptions(
      [{ id: "known", name: "Иван Иванов" }],
      ["known", "old-user"],
    ),
    [
      { id: "known", name: "Иван Иванов" },
      { id: "old-user", name: "Ранее выданный доступ 1" },
    ],
  );
  assert.deepEqual(readerOptions([], ["old-user", "old-user"]), [
    { id: "old-user", name: "Ранее выданный доступ 1" },
  ]);
});

test("reader display masks identity fallback returned by server", () => {
  assert.deepEqual(
    readerOptions([{ id: "old-user", name: "old-user" }], ["old-user"]),
    [{ id: "old-user", name: "Ранее выданный доступ 1" }],
  );
});

test("public-key input rejects private material before submission without leaking the value", () => {
  const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nnever-echo-me";
  assert.throws(
    () => publicKeyLines(secret),
    (error) =>
      error instanceof Error &&
      !error.message.includes("never-echo-me") &&
      error.message.includes("публичный"),
  );
  assert.throws(() => publicKeyLines("not-a-key"));
  assert.throws(() => publicKeyLines("  "));
  assert.deepEqual(
    publicKeyLines(" ssh-ed25519 AAAA branch\r\n\nssh-ed25519 AAAA branch "),
    ["ssh-ed25519 AAAA branch"],
  );
});

test("disabled uploaders can retain zero keys; enabling requires a public key", () => {
  assert.deepEqual(publicKeyLines("", false), []);
  assert.throws(() => publicKeyLines("", true));
  assert.throws(() => publicKeyLines("-----BEGIN PRIVATE KEY-----", false));
});
test("provider and provisioning labels keep error, stale, pending and unknown distinct", () => {
  assert.equal(providerLabel("healthy"), "SFTPGo доступен");
  assert.equal(providerLabel("stale"), "Данные SFTPGo устарели");
  assert.equal(providerLabel("error"), "Требуется проверка SFTPGo");
  assert.equal(providerLabel(undefined), "Состояние SFTPGo неизвестно");
  assert.equal(provisioningLabel("applied"), "Применено");
  assert.equal(provisioningLabel("pending"), "Не применено");
  assert.equal(provisioningLabel("conflict"), "Конфликт настройки");
  assert.equal(provisioningLabel("unexpected"), "Нет подтверждения");
});

test("account quota minimum sums shared folder quotas once, independent of current use", () => {
  const folders = [
    { id: "a", quota_bytes: 10 },
    { id: "b", quota_bytes: 20 },
  ] as Parameters<typeof minimumAccountQuota>[0];
  assert.equal(minimumAccountQuota(folders, ["a", "b", "a"]), 30);
  assert.equal(minimumAccountQuota(folders, []), 0);
});

test("provisioning errors expose useful translated reasons without reflecting provider data", () => {
  assert.match(provisioningReason("ownership_conflict"), /вне этого сервиса/);
  assert.match(provisioningReason("provider_auth_denied"), /отклонил доступ/);
  assert.ok(
    !provisioningReason("sensitive-raw-provider-message").includes(
      "sensitive-raw",
    ),
  );
});

test("quarantine errors explain rejected indexing without claiming the receiver is offline", () => {
  assert.match(
    provisioningReason("quarantined_receipts"),
    /остальные загрузки обрабатываются/,
  );
  assert.match(
    provisioningReason("event_integrity_error"),
    /не включён в архив/,
  );
  assert.match(provisioningReason("event_path_conflict"), /Спорная версия/);
  assert.equal(providerLabel("error"), "Требуется проверка SFTPGo");
});

test("receiver has no upload quota; sender retains shared folder budget validation", () => {
  const folders = [{ id: "a", quota_bytes: 20 * 1024 ** 3 }] as Parameters<
    typeof accountQuotaBytes
  >[2];
  assert.equal(accountQuotaBytes("receiver", NaN, folders, ["a"]), 0);
  assert.throws(
    () => accountQuotaBytes("sender", 10, folders, ["a"]),
    /суммы квот/,
  );
  assert.equal(accountQuotaBytes("sender", 20, folders, ["a"]), 20 * 1024 ** 3);
  assert.throws(() => accountQuotaBytes("sender", NaN, folders, ["a"]));
  assert.equal(accountKindLabel("receiver"), "Получатель");
  assert.equal(accountKindLabel(undefined), "Отправитель");
  assert.equal(accountKindLabel("future"), "Неизвестный тип");
});

test("deleted versions remain historical but are hidden from default lists, bytes and unread totals", () => {
  const active = {
    ...version("active", "a", "2026-10-20T10:00:00Z", true),
    can_download: true,
  };
  const deleted = {
    ...version("deleted", "a", "2026-10-21T10:00:00Z", true),
    deletion_state: "deleted" as const,
    can_download: true,
  };
  assert.deepEqual(
    orderedVersions([active, deleted], "", "", false).map((v) => v.id),
    ["active"],
  );
  assert.deepEqual(
    orderedVersions([active, deleted], "", "", false, true).map((v) => v.id),
    ["deleted", "active"],
  );
  assert.deepEqual(
    orderedVersions([active, deleted], "", "", true, true).map((v) => v.id),
    ["active"],
  );
  assert.deepEqual(versionSummary([active, deleted]), {
    newCount: 1,
    totalBytes: 1024,
  });
  assert.equal(versionCanDownload(deleted), false);
  assert.equal(
    versionCanDownload({ ...active, deletion_state: "pending" }),
    false,
  );
  assert.equal(
    versionCanDownload({ ...active, deletion_state: "uncertain" }),
    false,
  );
  assert.equal(versionCanDownload(active), true);
});
test("only explicit server-confirmed deletion can remove download/delete/unread rights in optimistic state", () => {
  const original = {
    ...version("v", "a", "2026-10-20T10:00:00Z", true),
    can_delete: true,
    can_download: true,
  };
  for (const response of [
    undefined,
    {},
    { status: "uncertain" },
    { status: "deleted", deleted_at: "invalid", deleted_by: "admin" },
    { status: "deleted", deleted_at: "2026-10-21T10:00:00Z", deleted_by: "" },
  ])
    assert.throws(() => confirmedDeletedVersion(original, response));
  const deleted = confirmedDeletedVersion(original, {
    status: "deleted",
    deleted_at: "2026-10-21T10:00:00Z",
    deleted_by: "admin",
  });
  assert.ok(isDeletedVersion(deleted));
  assert.equal(deleted.can_delete, false);
  assert.equal(deleted.can_download, false);
  assert.equal(deleted.is_new, false);
  assert.equal(original.can_delete, true);
  assert.equal(original.can_download, true);
  assert.equal(original.is_new, true);
});
