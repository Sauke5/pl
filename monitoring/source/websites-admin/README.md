# PL Websites Admin

Отдельный интерфейс управления HTTP- и content-проверками сайтов. Не устанавливается автоматически вместе с core PL. Сервис управляет выбранными оператором YAML-файлами HTTP targets, content targets и Blackbox modules. Перед записью создаёт snapshot, проверяет YAML и Blackbox, применяет изменения атомарно и выполняет read-back; ошибка после применения запускает rollback.

Для integrated-входа задаются `WEBSITES_ADMIN_AUTH_MODE=gateway` и `WEBSITES_ADMIN_PLATFORM_SSO_KEY_FILE` с индивидуальным raw32 ключом. Самостоятельный режим сохраняет собственные Argon2id credentials и SQLite sessions. Gateway mode требует подпись PL для каждого запроса и не переходит в standalone при ошибке подписи. Trusted hosts, SSRF allowlist, адреса Prometheus/Blackbox, paths и необязательные уведомления задаются для своей установки.

[Runtime layout и права](docs/production-layout.md) · [Контракт gateway](docs/platform-integration.md)

Python tests запускаются через pytest в каталоге приложения. `tests/admin_shell_browser.test.mjs` проверяет обе standalone-админки, а `tests/reports_shell_browser.test.mjs` — общую оболочку Reports. Browser fixtures используют Playwright из frontend PL и не применяют конфигурацию реальных сервисов. SQLite, snapshots, config targets и credentials не входят в исходники.
