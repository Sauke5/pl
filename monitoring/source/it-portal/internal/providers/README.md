# Контракты адаптеров

Все HTTP/DNS/TCP/TLS назначения проходят `netguard`: явные CIDR и порты, системный DNS с проверкой **всех** полученных адресов и соединением по проверенному IP, запрет loopback/link-local/multicast/metadata, TLS >=1.2 с системными и корпоративными CA. HTTP proxy env не используется. Redirect проверяется заново; запрос с Authorization не перенаправляется на другой origin. Никакие запросы не обходят проверку сертификата. Для внешних публичных источников также требуется разрешённый CIDR. Пустая allowlist запрещает исходящие подключения.

`NewWithDependencies` предназначен для контролируемых contract tests с локальными mock-серверами; входные параметры API не могут выбирать resolver/dialer.

- Prometheus: `GET <url>/api/v1/targets`, полный `status=success/data.activeTargets` обязателен. Stable external ID = SHA256(scrapePool + NUL + scrapeUrl). Mutable labels не меняют идентичность. `discovery_enabled=false` сохраняет проверку ответа Prometheus, но не предлагает технические scrape/probe endpoints как карточки. Отсутствующий флаг сохраняет прежнее включённое обнаружение. Настройки `include_job`/`exclude_job`: точные имена jobs через запятую. `match_label` + `match_value`: точное равенство. `instance_label`: label для предлагаемого имени (default `instance`). Результат всегда кандидаты, без разрешения операций.
- Alertmanager: `GET <url>/api/v2/alerts` с default active/silenced/inhibited. `fingerprint` — идентичность. Suppressed/silenced/inhibited остаются firing; наблюдения в `portal_alert_state`, `portal_silenced`, `portal_inhibited`. Только успешно полученный валидный **полный** snapshot может использоваться store для закрытия исчезнувших проблем; ошибки и null не являются пустым snapshot.
- Grafana: `GET <url>/api/health`, требуется `database=ok`. Портал не заявляет об импорте dashboards и не заменяет Grafana.
- Reports: периодический poll после health читает manifest через внутренний `GET /internal/reports/manifest` у настроенного generator URL, без redirects. Валидирует daily/weekly metadata и точное имя файла; импортирует существующие отчёты по стабильному URL, сохраняет их при ошибке/пустом индексе и объединяет с результатами генерации без дублей. Если индекс не содержит времени создания, портал показывает период без выдуманного timestamp. Генерация: существующий `scripts/monitoring_report_api.py`: health `GET /health`, генерация `POST /api/reports/run {target_date}`. Требуется `ok=true`, report с корректными url/date. `reports_base_url` задаёт публичный base URL для `/reports/...` (иначе integration.url); публичный архив требует Portal session. Генератор не отправляет Telegram из этого вызова. Сетевой сбой или неоднозначный ответ после POST — `ErrUnknown`; автоматического повторения нет.
- Docker: настроенный локальный Unix executor; поле integration.url не даёт выбрать произвольный Docker daemon. Poll проверяет executor `/health`; restart требует resource.operations `restart`, executor_target и явное подтверждение. Передаётся durable job.ID как request_id.

## Секреты

`Integration.secret_ref` — bearer token reference, не значение:

- `env:PORTAL_SECRET_<NAME>`; имя только `[A-Z0-9_]`.
- `file:<basename>` внутри `PORTAL_SECRETS_DIR` (default `/run/secrets/portal`); traversal и symlink escape запрещены, размер <=16 KiB.

Каждая ссылка дополнительно должна быть перечислена в `PORTAL_SECRET_REFS` через запятую. Значения не попадают в ошибки провайдера. Auth других схем требует отдельного адаптера; не передавайте пароль в URL или config.

## Проверки и обогащение

Execute `check`: parameters.kind `dns|tcp|http|tls`, parameters.target; если отсутствуют — Resource.Check, затем Resource.URL. TCP/TLS принимают host:port или HTTP(S) URL. HTTP возвращает HTTP code, reachable, http_success и `application_health=not_assessed`: HTTP 200 на странице входа не означает исправность приложения. TLS проверяет цепочку, hostname и срок. DNS возвращает разрешённые адреса. Таймаут 20 секунд.

Execute `enrich`: parameters.target или Resource.URL; 15 секунд, первые 256 KiB HTML, title <=180 символов. Результат `suggestions` (name/type/icon/check) отдельно от `observations` (HTTP status/time/content type), `requires_confirmation=true`. HTML не исполняется, внешняя favicon не загружается. Применение предложения и обнаружение дубликатов выполняет API/store, провайдер БД не меняет.

## Executor

Отдельный `cmd/executor` с единственным Docker socket mount:

- `PORTAL_EXECUTOR_SOCKET=/run/portal-executor/executor.sock`
- `PORTAL_EXECUTOR_ALLOWLIST=/etc/portal-executor/allowlist.json`: `{"targets":{"logical-name":"exact-container-name-or-id"}}`
- `PORTAL_EXECUTOR_JOURNAL=/var/lib/portal-executor/journal.json` (append-only JSONL, несмотря на совместимое имя).
- `PORTAL_EXECUTOR_DOCKER_SOCKET=/var/run/docker.sock`

API подключается через `PORTAL_EXECUTOR_URL=unix:///run/portal-executor/executor.sock`. Socket mode 0660, GID 10001. Allowlist перечитывается перед каждым новым запуском; exact target сначала разрешается в container ID, restart выполняется только по этому ID с stop timeout=10s. Разрешены только `/health` и `/v1/restart`; shell и другие Docker операции отсутствуют.

Перед POST Docker executor пишет `started` в append-only journal и fsync. Terminal result также fsync. Один request_id никогда не выполняется повторно, включая одновременные вызовы и перезапуск процесса. Найденный `started` после аварии означает `unknown`, а не повтор. Журнал защищён process flock; повреждение журнала блокирует запуск. Нужен постоянный volume, backup и сохранение журнала при обновлении. Потеря/замена журнала разрушает гарантию от повторов; не удаляйте его ради устранения unknown. Unknown требует проверки конкретного контейнера оператором. Это намеренная at-most-once гарантия, не обещание exactly-once для Docker.

Проверка: `go test -race ./internal/providers ./internal/netguard ./internal/executor` и `go vet` для этих пакетов. Тесты используют локальные контролируемые HTTP/TLS/Unix mocks; это не проверка корпоративных источников.

Worker ограничивает все виды poll четырьмя одновременными запросами. Для каждого источника snapshot применяется последовательно: максимум один poll, включая ручное обновление. Значение integration.concurrency — верхняя граница, эффективный предел snapshot-адаптеров всегда 1, чтобы старый ответ не перезаписал новое состояние. Проверки здоровья Grafana/reports/executor проходят через тот же scheduler. Сетевой timeout сохраняет ошибку источника отдельной транзакцией; остановка worker не объявляет источник неисправным. При shutdown worker дожидается завершения запущенных poll.

Prometheus scrape URL и Alertmanager generator URL проходят проверку HTTP(S), отсутствия userinfo и секретных query keys. Небезопасный scrape URL отклоняет snapshot, небезопасная необязательная диагностическая ссылка alert исключается. Labels с именами, обозначающими token/password/secret/API key/authorization/credential/cookie, исключаются из выдачи адаптера. Это не механизм автоматического распознавания произвольных секретов внутри обычного текста: upstream labels/annotations также не должны содержать секреты.

Ручная ICMP-проверка создаётся через `POST /api/v1/jobs` с `kind: "check"` и `parameters: {"kind":"icmp", "target":"<IPv4-адрес или hostname>"}`. Администратор задаёт только цель; выполнение по расписанию не поддерживается. API проверяет явно разрешённые `PORTAL_ICMP_ALLOWED_CIDRS`, разрешает hostname и закрепляет проверенный IPv4 перед передачей host helper. Пустой список запрещает все цели. Helper повторно проверяет собственную policy, запускает фиксированные 2000 пакетов с интервалом 2000 мкс, ограничивает выполнение 25 секундами и вывод 1 МиБ. API не получает `CAP_NET_RAW`; отдельный непривилегированный helper использует только эту capability. Допускается один активный запуск.

Сводные метрики доступны в списке и карточке задания. Полный вывод не включается в обычный polling: администратор получает его по отдельному `GET /api/v1/jobs/{id}/output`. Ошибка helper или неполный запуск не превращаются в успешный результат с нулевой потерей. Настройки socket и CIDR задаются установщиком; передача hostname в helper и произвольные аргументы процесса запрещены.
