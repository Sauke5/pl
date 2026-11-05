# Единый контракт SSO: портал → Python-приложения

Контракт PL v1 для двух Python-приложений. Документ описывает trust boundary и wire format; результаты установки и проверки входа фиксируются для конкретной сборки отдельно.

## Граница доверия

Портал Go проверяет свою действующую сессию и право администратора. Далее он проксирует запрос в фиксированный upstream monitoring-admin или websites-admin и подписывает идентичность и сам запрос. Адрес upstream не берётся из параметров клиента. Python проверяет подпись и необходимые scopes, но не создаёт локальную login-сессию.

Режимы Python-приложений: `standalone` сохраняет существующий вход, `gateway` требует подпись. В gateway нет fallback на локальные cookies, Basic или заголовок с именем пользователя. Отсутствующий/нечитаемый ключ останавливает запуск gateway-режима. Health остаётся отдельной узкой проверкой без идентичности.

Для каждого приложения нужен отдельный случайный ключ ровно 32 байта, общий только между порталом и этим приложением. Повторное использование ключа другого приложения отклоняется при запуске Платформы. Точный файловый формат v1: ровно 32 raw bytes. Не hex, не base64; не выполнять trimspace и не дописывать перевод строки. Размер, отличный от 32 bytes, отклоняется. Ключи monitoring-admin и websites-admin различаются. Секрет не передаётся браузеру, не входит в образ, Git, URL и логи; файлы монтируются read-only с минимальными правами для UID процесса.

Портал удаляет все входящие `X-PL-*`, `Remote-User`, `X-Auth-*`, `Authorization`, `Proxy-Authorization`, `Cookie` и клиентские forwarded identity headers перед отправкой upstream. Проверка portal cookie выполняется до удаления. Host, forwarded host/proto/prefix и IP формируются порталом из фиксированного public URL и проверенного непосредственного proxy peer. Upstream `Set-Cookie` локальной авторизации наружу не выпускается. Неподписанные forwarded headers не являются источником identity в Python.

## Ограничение параллельных запросов

`internal/server/gateway_capacity.go` ограничивает активные запросы и ожидающих для одного handler в процессе. Проверки сессии, route/method и действующие проверки операции выполняются до допуска к upstream. Выделение static lane не добавляет маршруты и не расширяет права.

| Запросы | Active | Pending | Ожидание |
|---|---:|---:|---:|
| Разрешённые static GET/HEAD: monitoring-admin, websites-admin, File Auditor, Forms, Wayline, Doska | 8 | 32 | до 5 с |
| Остальные разрешённые GET/HEAD этих gateways, кроме Doska | 4 | 16 | до 5 с |
| Doska normal lane | 4 | 16 | до 5 с |

Static использует отдельные slots. У ServiceGateway, Forms и Wayline read lane разделяет существующие operation slots с unsafe-запросами; unsafe не ставятся в новую очередь. POST остаётся unsafe и для read-only расчёта Forms. Doska сохраняет отдельные lanes для attachments и SSE. Directory сохраняет прежний admission contract. NetMap не входит в перечисленные gateway lanes этой PL-реализации.

Переполнение, истечение времени ожидания и отмена не должны отправлять запрос upstream или оставлять занятые slots. При подключении consumer проверяются параллельная загрузка CSS/JS с API, finite overflow, timeout/cancel и освобождение capacity. Браузерная приёмка также проверяет MIME и байты assets, сворачивание меню, тему после reload и logout.

## Два заголовка

```text
X-PL-Gateway-Assertion: <base64url без padding от UTF-8 JSON>
X-PL-Gateway-Signature: <base64url без padding от 32 байт HMAC-SHA256>
```

Подписываемые байты: ASCII `pl-gateway-v1\n` (реальный LF после v1), затем **точные ASCII-байты значения Assertion**. Ключ — точные 32 raw bytes файла appKey. Python проверяет HMAC constant-time по полученному Assertion и не пересериализует JSON. Это исключает различия порядка полей, пробелов и Unicode-escaping между Go и Python.

Отдельные v2 consumers используют те же два имени заголовков, HMAC domain `pl-gateway-v2\n`, issuer `pl` и свои точные schemas/audience. Это не автоматическое расширение v1 verifier. Детерминированные v2 fixtures: `docs/examples/directory-v2-vectors.json`, `auditor-v2-vectors.json`, `doska-gateway-v2-vectors.json`. Consumer проверяет свою версию и схему без fallback.

Общий файл `docs/examples/admin-v1-vectors.json` содержит positive v1 cases для обеих Python-админок. Go проверяет production signer, claims, derived CSRF и точные assertion/signature bytes; Python consumers проверяют эти опубликованные байты без повторной подписи собственного fixture.

Пример структуры assertion без реальных identity/секретов:

```json
{
  "v": 1,
  "aud": "monitoring-admin",
  "iat": 1790000000,
  "exp": 1790000030,
  "nonce": "<16–64 случайных байт в base64url; Go использует 32>",
  "sub": "<стабильный portal user ID>",
  "name": "<имя для интерфейса и аудита>",
  "admin": true,
  "scopes": ["audit:read", "containers:restart", "monitoring:read"],
  "method": "POST",
  "uri": "/admin/api/v1/containers/example/restart",
  "content_type": "application/json",
  "body_sha256": "<64 lowercase hex>",
  "idempotency_key": "<ключ операции или пустая строка>",
  "source_ip": "<проверенный IP клиента>",
  "csrf_token": "<derived service token>",
  "csrf_verified": true
}
```

Обязательны все перечисленные поля. В текущем registry зарегистрированы `aud` = `monitoring-admin` и `websites-admin`; приложение принимает только своё значение. Для нового сервиса явно регистрируется отдельный audience в issuer, gateway и verifier, с собственными scopes и ключом; wire-формат v1 при этом не меняется. Неизвестные audience отклоняются, универсальный fallback запрещён. `v` строго 1, `admin` строго boolean true, timestamps — целые числа. `scopes` — отсортированный список уникальных строк, выдаваемый конфигурацией портала, а не запросом клиента. Для monitoring-admin: `monitoring:read`, `containers:restart`, `audit:read`. Для websites-admin вводятся `websites:read`, `websites:write`: в standalone коде scopes отсутствуют, все авторизованные активные users имеют доступ; эта пара применяется именно в gateway mode. Изменяющие операции требуют write/restart scope; право чтения его не заменяет.

Ограничения: Assertion ≤ 8 KiB, `sub` ≤ 256 UTF-8 bytes, `name` ≤ 512 bytes, `uri` ≤ 4096 ASCII bytes, ключ операции ≤ 128 bytes. Запрещены CR/LF/control characters в строках, кроме обычного Unicode имени. Дубли JSON keys, дубли заголовков Assertion/Signature, неверный base64, неизвестная версия, неверные типы, missing fields отклоняются. Проверенные claims хранятся в request state; бизнес-код не читает исходные identity headers заново.

## Что именно сравнивается с запросом

- `method`: фактический uppercase HTTP method. Изменение метода после подписи недопустимо.
- `uri`: **итоговый upstream** raw escaped path и, если есть, `?` + raw query. Портал подписывает после выбора upstream path. Python сравнивает `scope['raw_path']` и `scope['query_string']`, а не decoded `request.url.path`, собранные параметры или отсортированный query.
- Prefix сохраняется: `/admin/...` и `/websites/...` входят в подписанную строку, если именно они отправлены upstream. Приложение не прибавляет `root_path` второй раз. Интеграционные тесты обязаны проверить фактический ASGI scope под deployment prefix.
- `content_type`: точное отправленное значение заголовка Content-Type, либо пустая строка. Не менять charset, multipart boundary и другие параметры после подписи.
- `body_sha256`: SHA256 **исходных байтов** тела. Не сериализовать JSON или формы заново. Для пустого тела — обычный SHA256 empty bytes. На стороне Python прочитанные bytes сохраняются для последующего route handler.
- `idempotency_key`: точное значение отправленного Idempotency-Key либо пустая строка. Нельзя подменить ключ, сохранив подпись того же тела.
- Рекомендуемый общий предел тела v1 — 2 MiB: bounded read на обеих сторонах, 413 при превышении, без запуска операции. Неподдержанный Content-Encoding отклоняется; автоматической распаковки/перепаковки между подписью и проверкой нет.

HMAC защищает целостность, но не шифрует внутренний HTTP. Контракт предполагает существующую доверенную backend-сеть; контейнер с доступом к перехвату её трафика не считается безобидным клиентом. Публичный клиент получает только портал, а не прямой неподписанный маршрут к Python-приложению.

## CSRF для JSON и HTML/HTMX

Точная формула:

```text
serviceCSRF = base64url_no_padding(
  HMAC-SHA256(
    key = UTF8(portalSession.CSRF),
    message = UTF8("pl-gateway-csrf-v1\n" + aud)
  )
)
```

Здесь `\n` — один LF. Результат — 43 ASCII-символа. Токен стабилен для одной сессии и приложения; разные приложения и новые login-сессии получают разные значения. Исходный portal CSRF и portal session cookie **не передаются upstream**.

GET HTML получает serviceCSRF в подписанном `csrf_token`. Python помещает его в существующие hidden `csrf_token`, meta и `/api/v1/session`. Локальная сессия ради этого не создаётся. Браузер продолжает отправлять обычные URLencoded формы и существующие HTMX/fetch-запросы без перехвата всех форм JavaScript.

Для POST/PUT/PATCH/DELETE портал проверяет:

1. Текущую portal session и admin-доступ.
2. Точный Origin, равный public origin. При отсутствии Origin допускается Referer с тем же scheme/authority. Оба отсутствуют — отказ. `Sec-Fetch-Site: cross-site` тоже отказ. Недостаточно существующего helper, который допускает полностью отсутствующий Origin.
3. Constant-time сравнение `X-CSRF-Token` с serviceCSRF; прямой JSON-клиент портала также может предъявить исходный session CSRF **в header**, который не отправляется дальше. Для HTML формы принимается только derived serviceCSRF из одного `csrf_token`; повторяющиеся/противоречивые значения отклоняются.
4. После успешной проверки устанавливает `csrf_verified=true`. Upstream header `X-CSRF-Token` нормализуется в serviceCSRF. Raw body сохраняется неизменным.

Python требует для unsafe method одновременно валидную подпись, body digest, `csrf_verified=true` и constant-time совпадение submitted derived CSRF (header либо hidden form) с подписанным `csrf_token`. Для GET/HEAD `csrf_verified=false`; они не запускают restart/apply/delete. OPTIONS не даёт обхода: не проксировать изменяющее действие через OPTIONS.

Прежние одноразовые websites `operation_token` остаются отдельной защитой конкретного apply/update/delete/rollback и не заменяются CSRF. Они привязаны к действительному portal subject через стабильную локальную identity, а не к одному общему пользователю gateway.

## Время, nonce и повторы

`exp = iat + 30` seconds, Unix UTC. Проверка при приёме: `0 < exp-iat ≤ 30`, `iat ≤ now+5`, `exp ≥ now-5`. Допуск часов 5 секунд, не продление TTL на минуты. Операция, принятая вовремя, может исполняться до обычного timeout 120–130 секунд: повторной проверки exp посреди операции нет.

Для unsafe запросов Python после полной проверки подписи, target/body и CSRF атомарно резервирует `(aud, nonce)` в защищённом lock TTL-cache до `exp+5`. Повтор отвергается 409 до бизнес-действия. Максимум 10 000 живых записей; при заполнении cache отклоняет новые unsafe запросы 503, не вытесняя живые nonce. GET/HEAD не нуждаются в одноразовом nonce. Портал не повторяет unsafe запрос автоматически после timeout.

Это **per-process** защита, не global exactly-once. Подтверждено 28.09.2026: monitoring-admin запускает один Uvicorn через `python -m app.serve`, websites-admin — Uvicorn с `--workers 1`; Gunicorn не используется. После рестарта cache пуст, при нескольких workers/репликах он раздельный. Поэтому ограничение v1 — один worker/реплика на приложение. Если понадобится глобальное предотвращение replay после рестарта, потребуется persistent atomic nonce store, это отдельное изменение.

Для restart gateway всегда передаёт подписанный Idempotency-Key в прежний durable job механизм. Если клиент уже передал ключ в header или поддерживаемом JSON-поле, сохраняется этот ключ; если ключа нет, Go назначает `gw-` + nonce. Клиентский API не получает нового обязательного поля. Python не должен генерировать другой случайный ключ при повторе того же подписанного запроса. Это не объединяет два новых пользовательских запроса с разными nonce; их идемпотентность требует стабильного ключа клиента. Websites сохраняет durable operation token, причём его consume должен быть атомарным (`UPDATE ... WHERE used_at IS NULL AND ...` с проверкой rowcount), иначе текущий SELECT→UPDATE допускает конкурентное применение одного token. Ни HMAC, ни локальный nonce cache не заменяют эту гарантию бизнес-операции.

## Identity без локальной login-сессии

`sub` — ключ идентичности; `name` — отображаемое имя, не уникальный логин и не право. Не использовать name как FK для действий и token ownership. Приложение может иметь локальную запись identity для FK/audit, но не выдаёт локальный auth cookie и не принимает её пароль в gateway-режиме.

У websites-admin существующий `operation_tokens.user_id` ссылается на `users.id`: его необходимо связать со стабильным portal subject. Нельзя подставлять постоянный user_id для всех. Возможна отдельная таблица provider/subject либо устойчивый namespace username с SHA256(subject), без коллизий с standalone пользователями и с unusable password hash. Выбранное отображение должно переживать рестарт и не менять существующие standalone accounts. AuthContext может содержать ephemeral session-like объект только для csrf; строка ServerSession в БД для входа не нужна.

В integrated mode вход выполняет Платформа: неавторизованный пользовательский запрос gateway направляется на `/`. Локальные `/login` и `/logout` приложения не открываются через allowlist gateway; самостоятельного login fallback нет. Выход клиента — same-origin `GET /api/v1/session`, затем `POST /auth/logout` с исходным portal CSRF и переход на `/`. Этот CSRF не передаётся backend приложения. Standalone маршруты сохраняют свою семантику. Возврат к исходной глубокой ссылке после нового входа текущим gateway не гарантируется; при добавлении такого поведения допустим только проверенный относительный return path.

## Dozzle: отдельный маршрут, отдельная проверка

`/admin/logs/` идёт напрямую из nginx в Dozzle и выполняет `auth_request /internal/dozzle-auth`. До интеграции subrequest проверял локальную сессию monitoring-admin через `/admin/api/v1/proxy-auth`; этот старый upstream заменён проверкой сессии Платформы в подготовленной конфигурации.

Реализованный маршрут сохраняет прямой streaming proxy nginx→Dozzle; internal auth upstream — узкий portal endpoint `GET /internal/auth/dozzle`. Он проверяет актуальную portal session/admin и возвращает 204 с серверным `X-Auth-User` (стабильный ASCII subject), либо 401/403. Для этого auth endpoint не нужны Python HMAC или CSRF: он ничего не меняет. Он не принимает user/scopes из клиентских headers. Внешний nginx маршрут к самому internal endpoint отсутствует; даже при прямом вызове backend он всё равно требует portal session.

Nginx передаёт cookie только auth subrequest, а Dozzle получает `Remote-User` **только** из ответа auth_request. Клиентские Remote-User/Remote-Name/Remote-Email/Remote-Groups/Authorization и portal cookie в Dozzle не передаются. Сохранить `DOZZLE_AUTH_PROVIDER=forward-proxy`, actions/shell/MCP=false, закрытый прямой порт Dozzle, buffering off, HTTP/1.1 и Upgrade/Connection для WebSocket.

Для read-only Dozzle подтвердить реальные методы используемых endpoints; GET/HEAD для страниц/SSE/WS разрешены. Если frontend использует POST для чтения, не открывать все unsafe методы бездумно: перечислить конкретный endpoint и применить отдельную Origin/CSRF-проверку. Для WebSocket nginx передаёт исходный Origin portal auth endpoint, который проверяет его для upgrade. Поддельный клиентский original-method/origin header не используется: значения задаёт nginx.

Auth_request проверяется при открытии SSE/WS, не на каждом сообщении. Logout/expiry не закрывает уже установленный поток автоматически, а idle `proxy_read_timeout` не ограничивает длительность активного потока. В v1 это нужно явно принять как ограничение уже открытого read-only stream; для немедленного отзыва требуется active stream registry/закрытие в прокси либо абсолютный TTL соединений. Не заявлять мгновенный отзыв без реализации и теста.

## Почему не Basic вместо assertion

Оба Python-приложения сейчас используют собственные сессии, а не общий Basic service login. Добавление серверного Basic само по себе всё равно потребует gateway auth mode, проверки trusted identity, сохранения per-user audit и CSRF. Один общий аккаунт ухудшает ownership operation tokens. Поэтому Basic не сокращает текущую задачу. Для Dozzle существующий nginx auth_request действительно проще подписанного Python запроса и должен остаться самостоятельным механизмом.

## Файлы и обязательные проверки

Портал: отдельный gateway proxy/auth handler и конфигурация ключей/фиксированных upstream; изменение общих server/auth файлов координирует основной агент. Python: config, gateway verifier, auth context/provider, web helpers, login/logout/template/session adapters. Websites дополнительно проверяет identity FK и operation token atomic consume. Nginx: `/admin/`, `/websites/`, internal Dozzle auth и stripping headers; Compose: ключи read-only и explicit auth mode. Production apply проводится отдельным согласованным циклом с backup/rollback.

Общий fixture для Go и обоих Python: один фиксированный тестовый ключ и assertion-byte-string, подпись, GET с escaped path/query, URLencoded form и JSON POST. Проверить изменённые method/path/query/body/content-type/idempotency-key, неправильный audience/key, дубли headers/JSON fields, expired/future timestamp, повтор nonce и конкурентный duplicate, missing/foreign Origin, неправильный CSRF, viewer и прямой запрос upstream без подписи. Проверить standalone login отдельно. Реальный browser: HTML/HTMX preview→apply без лишнего login; restart только по явному разрешению на тестовую цель; audit с разными portal subjects; Dozzle SSE/WS и документированная граница logout.

## Forwarded headers v1

Default deny для client headers upstream. Разрешены только нужные приложению `Accept`, `Accept-Language`, `Content-Type`, проверенные `Origin`/`Referer`, `If-None-Match`, `If-Modified-Since` и HTMX `HX-Request`, `HX-Target`, `HX-Trigger`, `HX-Trigger-Name`, `HX-Current-URL`, `HX-Boosted`, `HX-History-Restore-Request`. Эти HTMX hints не дают полномочий. `Host` и forwarded headers задаёт proxy; Content-Length пересчитывает Go transport.

`X-CSRF-Token` пересоздаётся в derived serviceCSRF после проверки исходного header/form; `Idempotency-Key` задаётся проверенным client key или gateway fallback и подписывается. Все `X-PL-*`, `X-Auth-*`, `Remote-*`, `Authorization`, `Proxy-Authorization`, `Cookie`, непроверенные `X-Forwarded-*` и hop-by-hop headers удаляются; header names из входящего `Connection` тоже удаляются. Не переносить подпись при redirect на другой upstream. Python auth/assertion headers не отражаются в ответе или логах. Dozzle Upgrade/Connection — отдельное исключение в прямом nginx streaming route, не общее правило для Python proxy.

## Детерминированный тестовый вектор

Данные ниже публичные, **только для тестов**, непригодны как production key. Проверять с `now=1790000000`; это не действующая assertion. Key — 32 ASCII bytes строки `0123456789abcdef0123456789abcdef`, без LF. Исходный тестовый portal CSRF — ASCII `test-only-portal-csrf`. Тело — точные UTF-8 bytes `{"idempotency_key":"test-restart-001"}`, без LF. Payload сериализован компактно в показанном порядке; verifier использует полученный base64, а не порядок своей JSON-сериализации.

```json
{
  "claims": {
    "v": 1,
    "aud": "monitoring-admin",
    "iat": 1790000000,
    "exp": 1790000030,
    "nonce": "AAECAwQFBgcICQoLDA0ODw",
    "sub": "ad:test-user",
    "name": "Тестовый пользователь",
    "admin": true,
    "scopes": [
      "audit:read",
      "containers:restart",
      "monitoring:read"
    ],
    "method": "POST",
    "uri": "/admin/api/v1/containers/example/restart?check=a%2Fb&check=c",
    "content_type": "application/json",
    "body_sha256": "b0048b1a81c9d025236128cd39df65e1690185470a2916db714d46e13d591296",
    "idempotency_key": "test-restart-001",
    "source_ip": "192.0.2.10",
    "csrf_token": "8VarvVMvHVXGZEhOTYEePO0D2-6547i_ztTGCS75hxw",
    "csrf_verified": true
  },
  "expected_service_csrf": "8VarvVMvHVXGZEhOTYEePO0D2-6547i_ztTGCS75hxw",
  "assertion": "eyJ2IjoxLCJhdWQiOiJtb25pdG9yaW5nLWFkbWluIiwiaWF0IjoxNzkwMDAwMDAwLCJleHAiOjE3OTAwMDAwMzAsIm5vbmNlIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EdyIsInN1YiI6ImFkOnRlc3QtdXNlciIsIm5hbWUiOiLQotC10YHRgtC-0LLRi9C5INC_0L7Qu9GM0LfQvtCy0LDRgtC10LvRjCIsImFkbWluIjp0cnVlLCJzY29wZXMiOlsiYXVkaXQ6cmVhZCIsImNvbnRhaW5lcnM6cmVzdGFydCIsIm1vbml0b3Jpbmc6cmVhZCJdLCJtZXRob2QiOiJQT1NUIiwidXJpIjoiL2FkbWluL2FwaS92MS9jb250YWluZXJzL2V4YW1wbGUvcmVzdGFydD9jaGVjaz1hJTJGYiZjaGVjaz1jIiwiY29udGVudF90eXBlIjoiYXBwbGljYXRpb24vanNvbiIsImJvZHlfc2hhMjU2IjoiYjAwNDhiMWE4MWM5ZDAyNTIzNjEyOGNkMzlkZjY1ZTE2OTAxODU0NzBhMjkxNmRiNzE0ZDQ2ZTEzZDU5MTI5NiIsImlkZW1wb3RlbmN5X2tleSI6InRlc3QtcmVzdGFydC0wMDEiLCJzb3VyY2VfaXAiOiIxOTIuMC4yLjEwIiwiY3NyZl90b2tlbiI6IjhWYXJ2Vk12SFZYR1pFaE9UWUVlUE8wRDItNjU0N2lfenRUR0NTNzVoeHciLCJjc3JmX3ZlcmlmaWVkIjp0cnVlfQ",
  "signature": "TUhJ6q8-O85ImARF0JqL6ZfwHdqCK8DW1mpGKwbAsWU"
}
```
