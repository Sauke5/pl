# Inventory: исходники для PL

Inventory — подключаемый модуль инвентаризации ПО: Python ASGI, SQLite и
HTML/CSS/JavaScript. Core PL не скачивает его образ при первоначальной установке.
Администратор устанавливает модуль из каталога PL; интерфейс открывается по
`/inventory/` через действующую сессию администратора. Отдельного входа нет.

Сборщик формирует независимый артефакт из явно выбранных исходников:

```sh
python3 installer/package.py context --with-inventory --output SOURCE.tar.gz
python3 installer/package.py module --module-id inventory \
  --source-archive SOURCE.tar.gz --platform linux/amd64 \
  --version VERSION --output INVENTORY.tar.gz
```

Версии, content ID, архитектура и контрольные суммы указаны в manifest артефакта.
Исходники и unit tests не подтверждают приёмку конкретного опубликованного образа;
Linux-установка, gateway и настоящий импорт проверяются отдельно.

## UI и библиотека

Web использует центральные assets `@pl/ui` версии `1.0.2-pl.1`:
`/ecosystem/ui-v1.js`, `ui-v1.css`, `theme-catalog.js`, `theme-runtime.js`,
`theme-menu.css`. Браузерные globals — `PLUI` и `PLTheme`, namespace — `pl-ui-*`.
Это vanilla consumer библиотеки; npm-сборка ему не нужна. Центральный пакет
собирается владельцем Платформы, локальных копий shell/theme в этом каталоге нет.

Shared shell ожидает JS и готовый CSSOM не более 8 секунд. Ошибка или таймаут
сохраняет исходную страницу; reload позволяет повторить подключение. Bootstrap
ожидает завершения этого выбора перед созданием отчёта. Сессия приложения
читается через `/inventory/api/session`; выход использует общий
`/api/v1/session` и `POST /auth/logout` с его CSRF. Эти общие routes предоставляет origin Платформы.

Пустой набор отображается как отсутствие загруженных данных. Bootstrap получает
страницы одного revision, отклоняет циклы и неверную последовательность, повторяет
загрузку при смене revision один раз. Полное ПО запрашивается отдельно с bounded
pagination, фильтрами и сортировкой. Ошибка обновления сохраняет предыдущие
результаты и даёт повторить запрос. Ответы об отсутствии лицензии, спорном
основании, технической активации и отсутствии данных остаются разными состояниями.

## Конфигурация и секрет архива

Сохраняется существующий gateway mode по умолчанию. Он требует отдельный raw
32-byte key в файле `INVENTORY_GATEWAY_KEY_FILE` (по умолчанию
`/run/secrets/inventory-gateway.key`). Headers — `X-PL-Gateway-Assertion` и
`X-PL-Gateway-Signature`; HMAC domain — `pl-gateway-v2\n`, audience — `inventory`.
Точная схема claims и проверки body/URI/CSRF/scopes/replay сохранены в verifier.
Существующий development mode разрешает только loopback и не принимает gateway
headers. Нового способа входа нет.

`INVENTORY_DATA_DIR` задаёт writable data directory (исторический default `/data`).
Для очереди и nonce cache сохраняется один process/worker; импорт выполняется
одним parsing worker. Переключение на несколько процессов требует отдельного
согласования хранения и синхронизации.

Встроенный пароль и placeholder из передачи удалены. Для проверки зашифрованного
ZIP нужно явно задать `INVENTORY_ARCHIVE_PASSWORD_FILE` с путём к доступному
сервису secret file. Файл содержит от 1 до 4096 байт **точного пароля**: без
автоматического удаления пробелов или перевода строки. Пароль задаётся администратором в настройках установленного модуля PL и
сохраняется host controller в отдельном закрытом файле. Значение не возвращается
браузеру, не записывается в jobs, SQLite или result и не выводится в лог.
Сервис читает его только при запросе нового импорта. Embedded Python caller
может передать `archive_password=bytes` непосредственно `Importer.parse`.

Без файла, при ошибке чтения, пустом или слишком большом значении существующие
отчёты доступны. Job проверки нового комплекта завершается
`archive_password_not_configured` с понятным сообщением; preview/publication не
выполняются. Неверный пароль остаётся ошибкой проверки входного архива. Изменение
файла настройки не переписывает архивы и не меняет существующие данные.

## Локальные проверки

Из корня portable checkout:

```sh
python3 -m venv apps/inventory/.venv
apps/inventory/.venv/bin/python -m pip install -r apps/inventory/requirements.txt
PYTHONPATH=apps/inventory apps/inventory/.venv/bin/python -m unittest discover -s apps/inventory/tests
node --test apps/inventory/tests/shell-browser.test.mjs
PL_INVENTORY_BROWSER=webkit node --test apps/inventory/tests/shell-browser.test.mjs
```

Browser tests используют установленный Playwright из frontend Платформы, настоящий
static UI и центральные assets, синтетический same-origin API. Они не выполняют
реальные импорты. Python tests создают собственные небольшие encrypted ZIP/Excel
и временные SQLite: проверяются парсинг, idempotency, rollback, актор, auth,
лимиты и config secret. Tests отделены от runtime allowlist.

Зафиксированные requirements проверены в app-local venv на Python3.15.1.
Для module build используется `deploy/images/inventory.Dockerfile` из build
context Платформы; отдельный Dockerfile в каталоге сервиса предназначен для
standalone source context. Локальные проверки не подтверждают опубликованный
образ, установленный runtime или принятие реальных архивов.

## Лицензии и данные

Собственный код распространяется по [MIT](LICENSE). Сторонние зависимости
сохраняют своё авторство и лицензии. Публичные названия и URL разработчиков ПО
в справочнике — данные классификации. Рабочие базы, отчёты, архивы, credentials
и внутренние baseline manifests не входят в поставку.

Native controller создаёт один непривилегированный контейнер с read-only root,
отдельной private сетью и persistent хранилищем. Служебный порт в LAN не
публикуется. Отключение сохраняет данные и настройки. Удаление из PL удаляет
принадлежащие этому экземпляру данные после подтверждения имени модуля.
