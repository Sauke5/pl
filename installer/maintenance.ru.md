# Резервная копия PL core и восстановление

`maintenance.py` запускается от root на Linux-хосте установленной PL. Используется только локальный Docker socket `/var/run/docker.sock` и тот же `state/install.lock`, что у установщика. Команды не запускают Docker, не скачивают образы и не обращаются к production.

Это резервная копия **данных конкретной установки**, а не распространяемый релиз. Архив содержит PostgreSQL custom dump, текущий Argon2id hash локального администратора из auth volume и признак необходимости смены пароля, а также метаданные проверки совместимости. В нём могут находиться персональные данные, настройки подключений и секреты из БД. Храните его отдельно от Git, исходников, release package и публичных файловых серверов. Архив и его каталог должны принадлежать root; файл создаётся с правами `0600`, каталог не должен разрешать запись группе и остальным.

## Создание копии

```sh
sudo python3 /opt/pl/releases/<version>/maintenance.py backup \
  --root /opt/pl \
  --output /root/pl-backup.tar
```

Файл назначения должен быть новым. Инструмент проверяет installation identity, сохранённое состояние, manifest и его файлы, Compose, реальные image IDs, labels и mounts контейнеров и volumes. Из работающих сервисов временно останавливаются только web и API; PostgreSQL остаётся запущенной. `pg_dump --format=custom --no-owner --no-acl` формирует согласованную копию, затем считывается live authentication state. Исходное состояние API/web восстанавливается и при ошибке. Уже остановленные сервисы инструмент не запускает.

Это короткое плановое окно недоступности UI/API. Прямые записи сторонних программ в PostgreSQL во время обслуживания не поддерживаются. Дополнительные модули в этот архив не входят.

В конце выводится SHA256 архива. Сохраните его отдельно от самого архива. В stdout не выводятся данные БД, hash или пароли; ошибки внешних команд полностью скрываются, их return code и fingerprint stderr сохраняются в root-private `private/maintenance-error.json`.

В архив не входят Docker images, исходники, Git history, runtime logs, TLS key/certificate, первоначальный password seed и пароль PostgreSQL. Копируется именно **текущий** hash из volume, который мог измениться после установки.

В пакетах с feature `connector_credentials` архив также содержит отдельный 32-byte ключ `integration-credential-key`. Он нужен для расшифровки credentials из таблицы `integration_credentials`; ключ и БД должны переноситься вместе. Перед dump инструмент проверяет все сохранённые envelopes штатным codec API. Поэтому такой архив даёт доступ к сохранённым ключам интеграций и требует той же защиты, что исходный сервер. Ранее подготовленные `file:`/`env:` secrets в него не входят.

## Восстановление в другую свежую установку

Сначала тем же релизным пакетом установите отдельную PL с собственными root, HTTPS origin/портом и installation ID. Например, dev-проверка использует `/opt/pl-restore-check` и `https://127.0.0.1:18443`. Целевая установка должна иметь такое же имя локального администратора, версию пакета, manifest SHA256, image IDs, PostgreSQL major и schema contract. Её TLS, пароль PostgreSQL, адрес, порт и installation ID сохраняются.

```sh
sudo python3 /opt/pl-restore-check/releases/<version>/maintenance.py restore \
  --root /opt/pl-restore-check \
  --backup /root/pl-backup.tar \
  --backup-sha256 <независимо-проверенный-SHA256>
```

Принимать можно только доверенный backup: PostgreSQL dump способен содержать исполняемые SQL-объекты. SHA256 удостоверяет выбранные байты, а происхождение архива должен установить администратор. Файл проверяется как root-owned regular `0600`; symlinks, неожиданные пути, повторные entries, специальные файлы, неверные размеры и internal hashes отклоняются до изменения сервисов/БД. Максимальный database dump — 8 GiB.

**Работающая исходная установка никогда не перезаписывается.** Restore требует другой installation ID и свежую целевую БД. Разрешены только migration scaffolding, два точных неизменённых документа `settings/global` и `dictionaries/global` из `Defaults()`, local-admin sessions/login attempts и записи аудита `auth.login` от local-admin, создаваемые установщиком при приёмке. Наличие ресурсов, integrations, collections, preferences, jobs, событий, import plans, иных audit records, изменённых defaults, custom schemas, large objects или локальных пользователей запрещает restore. Принимаются конечные наборы таблиц существующих migrations: прежний core, добавленные SFTP/organization/journal/local-directory scaffolds и feature-gated `integration_credentials`. Все пользовательские таблицы должны быть пусты; `sftp_provider_state` и `org_cursor_state` допускаются только с единственной точной первоначальной записью. Даже local-admin account в directory feed или отметка чтения журнала означает использованную цель. Неизвестные и частичные наборы таблиц отклоняются. Изменённый пароль целевого администратора также означает, что нужна новая установка.

После остановки API/web свежесть проверяется повторно. Dump восстанавливается в случайную staging DB через `pg_restore --single-transaction --exit-on-error`. Schema contract проверяется ещё раз; **все** sessions, OIDC states и login rate-limit buckets удаляются из восстановленной БД. Старые browser sessions после восстановления не действуют. Затем исходная свежая БД переименовывается в временную, staging получает имя `pl`, а auth volume получает сохранённый hash/marker с владельцем UID/GID `10001:10001` и правами `0600`. Только после успешной замены данных/auth и возврата готовности исходно работавших API/web удаляется старая **свежая** БД. Если запуск или readiness завершается ошибкой, выполняется тот же rollback БД/auth.

Если восстановление staging не удалось, рабочая целевая БД остаётся прежней. Если ошибка произошла после переименования, инструмент пытается вернуть прежнюю БД и auth. Staging с восстановленными/частичными данными автоматически не удаляется: имя записывается в `private/restore-recovery.json`, объект сохраняется для расследования. При неполном rollback API/web остаются остановленными; обе БД и auth volume сохраняются. Удалять recovery objects можно только после проверки их содержимого и фактической рабочей БД. Операций `volume rm`, `prune`, удаления исходной БД или автоматического восстановления поверх пользовательских данных нет.

Определения constraints сравниваются в представлении самого PostgreSQL
`pg_get_constraintdef(oid, true)` при одинаковом major сервера. Это устраняет
различие избыточных скобок у ассоциативного `AND` после `pg_dump`/`pg_restore`.
Выражения не очищаются регулярными выражениями: границы, литералы, значимая
группировка `AND`/`OR`, имена constraints, колонки и индексы остаются частью
строгого schema contract. Отдельная CI-регрессия проверяет настоящий round trip
и отказ при таких изменениях.

Для `connector_credentials` свежая целевая таблица должна быть пустой. До переключения БД отдельный read-only verifier из того же API image проверяет каждый envelope staging DB с ключом из архива. Только после этой проверки, пока API остановлен, инструмент записывает исходный ключ в существующий private-файл целевой установки, сохраняя inode, владельца и права readonly bind mount. При ошибке возвращает прежний ключ вместе с БД/auth. Installation ID, HTTPS origin, TLS и пароль БД цели сохраняются; привязка credentials к integration ID и адресу Mailcow берётся из восстановленной БД. Не удаляйте архив, ключ или recovery objects при незавершённом rollback.

Ключ создаётся установщиком один раз как `private/integration-credential-key`, root:service-group `0640`, под root-private каталогом `0700`. API UID `10001` читает readonly mount через дополнительную service group. Ключ не зависит от пользовательского пароля, DB password или controller key и не пересоздаётся при повторном install. Для новых пакетов нужен явный `--network-cidr`: API сразу получает egress с проверенным IPAM, чтобы последующие подключения из UI не требовали перезапуска. Общие allowlists проверок и интеграций это не расширяет. Старые пакеты без feature сохраняют прежний Compose и формат backup; перенос между разными package/schema contracts по-прежнему запрещён.

## Границы проверки

Targeted unit tests проверяют archive validation, fresh-target gate, live hash вместо seed, возобновление сервисов при ошибке, revoke sessions, rollback БД/hash и остановку при провале rollback. Они используют mock Docker/PostgreSQL. Реальная приёмка на Linux с PostgreSQL проводится отдельно и фиксируется основным этапом разработки; этот документ сам по себе её не подтверждает.

Инструмент не выполняет обновление версии/schema и не реализует backup/restore дополнительных модулей. Для восстановления требуется установленный релиз той же сборки с доступными локальными образами и достаточным местом одновременно под backup, staging и свежую БД.

## Локальные модули

Этот механизм копирует core database и live auth. Он не копирует TSDB/configs/controller journals локальных модулей. Если в установке есть local module record либо каталог экземпляра, backup/restore отклоняется до quiesce; отключение модуля не снимает запрет, поскольку его данные сохранены. Restore также проверяет staging DB до переключения. Не удаляйте module records/data ради обхода проверки: следующий этап должен добавить пригодные native backup/restore hooks.
