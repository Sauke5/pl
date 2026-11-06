# Аварийное восстановление всей установки PL

`disaster-recovery.py` создаёт приватный offline backup core и локальных native
модулей. Restore возвращает **ту же установку**: прежние installation ID,
абсолютный root, HTTPS origin, instance UUID, данные, пароли, TLS и ключи.
Это отдельный механизм. Ограничение core-only у `maintenance.py` сохраняется;
delivery rollback остаётся восстановлением конкретной незавершённой операции.

Локальные archive/filesystem/finite-engine tests не заменяют восстановление
после фактической потери Docker volumes и root.
Матрица native приёмки конкретного опубликованного артефакта указывается в его
release receipt.

## Предварительные условия

Источник — idle ready минимальный schema-2 on-demand core. API/web/DB работают,
нет queued/running jobs, незавершённого upgrade/configuration/module lifecycle
или private pending plan. Состав private state, записей PL и Docker совпадает.
Поддерживаются конечные managed recipes Prometheus, Xray, Alertmanager, Wayline,
Grafana native schema 2, Forms, Doska, SFTPGo, NetMap и BookStack. Выключенные
экземпляры и их данные тоже включаются. Unknown/orphaned/foreign resources,
custom runtime drift, внешние data mounts/tablespaces и volume drivers с options
вызывают отказ; архив не объявляется полным при пропуске такого объекта.

Target — Linux с той же CPU architecture, локальным Docker Engine 29.x,
Compose 2.24+ (2.x) либо 5.x, Python 3.10+, systemd и штатными host dependencies
установщика. Для ICMP нужен доверенный `/usr/sbin/hping3`. Установка Docker,
пакетов ОС, routing/firewall и перенос между версиями БД этим инструментом не
выполняются. Родитель исходного root уже должен существовать и принадлежать root.
Нужен запас места на staging, восстановленные данные и распаковку images.

Источник должен оставаться fenced после его потери: нельзя одновременно поднять
старую и восстановленную установку с одним ID. Прежние root/origin/bind addresses,
порты и CIDRs должны быть доступны. При конфликте инструмент отказывает,
не перенумеровывает сети и не присваивает чужие Docker objects.

## Создание резервной копии

Используйте доверенную установленную версию инструмента и соседних host helpers:

```sh
sudo python3 /opt/pl/releases/VERSION/disaster-recovery.py backup \
  --root /opt/pl \
  --output /secure/pl-full.tar
```

`/secure` — собственный закрытый каталог root вне installation root. Output
должен быть новым файлом; существующий файл не заменяется. Готовый архив имеет
режим 0600. JSON-ответ сообщает backup UUID, installation ID, размер и SHA256.
Сохраните этот SHA отдельно от архива по доверенному каналу. Backup содержит
все ключи доступа; он не относится к публичному release и требует такого же
контроля хранения, как сама установка.

Во время snapshot инструменты закрывают API/web и controller writers, затем
native application/worker writers и storage. Все данные снимаются с остановленных
containers. Running/disabled state сохраняется, source возобновляется после
успеха или ошибки. На admission удерживаются nonblocking barriers
install → delivery → worker → lifecycle. Перед snapshot повторяются проверки
records, jobs, container recipes и foreign volume consumers. Неуспешный clean
shutdown не выдаётся за пригодный cold backup.

Архив содержит core PostgreSQL, **живой auth volume**, все native data/attachments,
private configs/credentials, active и immutable supervisor releases, зарегистрированные
module receipts, replay state и exact image payload. Файлы сохраняют numeric
uid/gid, modes, links и xattrs. Временные transfer spools, sockets, PIDs, открытые
locks, старые operation snapshots и готовые host units не переносятся. ICMP socket
directory/units/policy/payload создаются заново из проверенного host tooling.

Значение `initial-admin-password` может быть старым: текущий пароль определяется
сохранённым live auth volume. Внешний Mailcow и другие внешние сервисы не становятся
частью backup: входят их настройки и credentials в PL.

## Cold restore

Не запускайте обычный fresh install перед restore. Он создаёт другую identity
и новые ключи. Target root должен отсутствовать; root другой готовой установки,
даже пустой, не подходит. При нужном свободном UID/GID инструмент создаёт прежнюю
nologin service account; совместимую существующую учётку только проверяет.
Чужие account/UID/GID, units или Docker resources не заменяются.

```sh
sudo python3 /path/to/trusted-release/disaster-recovery.py restore \
  --root /opt/pl \
  --installation-id pl-0123456789ab \
  --backup /secure/pl-full.tar \
  --backup-sha256 YOUR_SEPARATELY_RETAINED_SHA256
```

Подставьте **исходные** root и installation ID. Инструмент сначала проверяет
внешний SHA, полный manifest/payload set, внутренние hashes/размеры, archive paths,
trusted release key, finite image/role/volume/network graph и target conflicts.
Код из непроверенного архива не исполняется. После image load снова сверяются
content IDs, CPU architecture и provenance.

Новые архивы содержат `contract_version: 2`. В контракте контейнера записи
`HostConfig.Mounts` упорядочены по Target и полному содержимому записи,
а `HostConfig.Binds` — по destination и полной строке. Sources, destinations,
modes, read-only flags и propagation проверяются целиком. Повторяющиеся destinations,
в том числе между двумя списками, и некорректные absolute targets вызывают отказ.
Docker default `OomKillDisable=false/null`
сопоставляется одинаково; значение `true` остаётся отдельным.
Пустые DNS overrides `HostConfig.Dns`, `DnsOptions` и `DnsSearch` имеют единое
представление для `null` и пустого списка: Docker может изменить его при рестарте
daemon. Отсутствующие поля не добавляются; значения и порядок непустых списков,
а также другие типы значений остаются различимыми.

Для опубликованных beta `0.5.1` и `0.5.2` сохранён ограниченный reader прежнего
контракта: отсутствие `contract_version` либо значение 1. Он проверяет старый
digest перестановками тех же полных Mounts records и Binds strings — не более
шести записей в каждом списке и 720 комбинаций порядка суммарно. Две формы
OOM default и максимум восемь комбинаций пустых DNS defaults проверяются отдельно:
общий предел — 11 520 полных digest checks, проверяемый до перебора. Другие версии
старого формата, превышение лимита
или несовпадение полей вызывают отказ до запуска writers. Version 2 использует
канонический digest без перебора. Это версия описания ресурсов в backup.

После commit controller активируется из проверенных существующих releases и
pointers. Его registry и ключ сохраняются; доставка проверяет текущий
`delivery.json` по schema, ownership и допустимому catalog URL с прежним trust key.
Настройки доставки после commit могут отличаться от архивных; их текущие bytes
и inode сохраняются. Первичная инициализация конфигурации при recovery не вызывается.
Unit создаётся по конечному шаблону в `/etc/systemd/system` атомарным Linux
`renameat2(RENAME_NOREPLACE)`. Чужой unit, mask, drop-ins, несовпадающие ownership,
ключ или socket вызывают отказ до создания unit и запуска controller. Существующий
канонический unit сохраняется. Готовность socket ограничена 30 секундами; его
owner, GID, mode и `SO_PEERCRED` PID сверяются с MainPID этого unit.

Для временного Directory relay ingress проверяется отдельно: отсутствие IPAM
override либо ровно `IPv4Address: ""` и `IPv6Address: ""` допустимы как запрос
автоматического выделения адресов. Другие поля, типы и непустые адреса вызывают
отказ. Полный fingerprint контейнера и общий контракт backup при этом сохраняются.

Файлы, owned volumes, три сети core (backend/ingress/egress) и native networks,
а также containers создаются по конечным recipes, без replay
произвольных Docker arguments или systemd units. Все containers остаются
в состоянии `created` с нулевым `StartedAt`. Прежние физические Docker IDs меняются; в журнал записываются
фактические созданные IDs. Единственная native physical reference, которую нужно
перепривязать, — Grafana `network_id`; меняется только ссылка на новый owned
ingress network, secret/root URL/config сохраняются. Служебные динамические
loopback endpoints могут измениться; настроенные внешние SFTP/Xray bindings
сохраняются.

До commit проверяются **байты, ownership, images и результат закрытых recipes**.
Затем `syncfs` синхронизирует каждый distinct filesystem для root, Docker data root
и owned volumes; только после этого journal получает durable commit. Одного
чтения page cache для этого недостаточно. В Docker 29.1.3 daemon autostart требует
`HasBeenStartedBefore`; новые create-only объекты эту границу не переходят.
[Контракт Engine](https://github.com/moby/moby/blob/docker-v29.1.3/daemon/daemon.go#L492).
Приёмка после daemon restart перед commit проверяется отдельно в native VM.
Это ещё не semantic application readiness. После durable commit запускается
core DB, проверяются schema/live auth и расшифровка credential envelopes.
PL sessions, OIDC transient states и local login attempts отзываются **до**
запуска API/web/native user writers. Password hashes и crypto keys не меняются.
Общий logout самостоятельных Grafana/BookStack этим SQL не заявляется.

Затем заново подготавливаются доверенные controller/ICMP units и запускаются
private API и ровно ранее работавшие native роли. Обычный PL web пока остановлен.
Его HTTPS-порт временно занимает отдельный relay из exact core web image,
подключённый к проверенным backend и ingress networks. Он пропускает только GET
к четырём существующим machine-authenticated Directory paths работающей Doska;
Authorization проверяет обычный backend. Auth/session/general API, UI и native
user routes недоступны: остальным запросам возвращается 503 с no-store и Retry-After.
Фактический relay container ID и его network attach сохраняются до start.

После прямой native readiness снимаются общие barriers; command lock продолжает
исключать второй recovery. Инструмент ждёт обычных **новых** module refresh jobs,
нового LastSuccess и совпадения module/integration endpoints с фактическими native
endpoints. Xray проверяется отдельно без выдуманной HTTP integration. Только после
этого точный owned relay ID останавливается/удаляется и запускается настоящий web.
По timeout данные сохраняются, web остаётся закрытым; `resume` повторяет проверку,
а не импорт. Выключенные экземпляры остаются выключенными.
Проверка пригодности backup в вашей
среде завершается настоящими браузерными сценариями и чтением native файлов:
HTTP 200 сам по себе не подтверждает данные.

## Ошибки, статус и повтор

```sh
sudo python3 /path/to/trusted-release/disaster-recovery.py status --root /opt/pl

sudo python3 /path/to/trusted-release/disaster-recovery.py resume \
  --root /opt/pl \
  --installation-id pl-0123456789ab \
  --backup /secure/pl-full.tar \
  --backup-sha256 YOUR_SEPARATELY_RETAINED_SHA256
```

Private journal: `ROOT/recovery/operation.json`. Передавайте тот же backup UUID
и SHA. До commit target остаётся закрытым, staged data сохраняются; повтор
проверяет actual created resource identities и продолжает конечные шаги.
`last_failure` сохраняет phase, тип ошибки и до 12 source frames: basename файла,
номер строки и имя функции. Публичный `status` возвращает короткое состояние
и failed step. Фаза `constructing` относится к созданию контейнеров.
При неоднозначном crash между Docker create и durable checkpoint объект не
присваивается по одному имени: инструмент отказывает и оставляет его для проверки.
Ни foreign objects, ни source backup, ни target данные автоматически не удаляются.

После `committed: true` выполняется **только resume**. Если readiness не вернулась,
данные сохранены, но ingress или часть приложений ещё могут быть недоступны.
Старый snapshot поверх уже принятых пользовательских записей не восстанавливается.
Повтор завершённой операции возвращает receipt и не импортирует архив заново.
До завершения recovery не запускайте отдельное обновление или reconfiguration.

CLI/receipt не выводят private values и subprocess bodies. `failed_step` и
`error_kind` указывают этап; systemd и container identity/state проверяются отдельно.
Если ошибка произошла при возобновлении source после backup, готовый sealed файл
уже может существовать: не перезаписывайте его повторной командой.

## Границы первой версии

Смена installation ID/root/origin, CPU architecture, image/schema/database major,
restore поверх рабочей установки, unmanaged data, network remapping и глобальный
Docker/OS cleanup не поддерживаются. Внешние архивные symlinks, special files и
более 500000 entries в одном data tree отклоняются. Source-only tests не являются
приёмкой чистого Linux host, lost-volume recovery, module data или crash recovery.
