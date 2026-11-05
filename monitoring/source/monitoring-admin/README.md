# PL Monitoring Admin

Отдельная операционная консоль с SQLite, сохранёнными jobs и ограниченным host-agent. Не устанавливается автоматически вместе с core PL. Web и worker не получают Docker socket; host-agent исполняет только фиксированные операции для своего явного реестра сервисов.

Standalone-вход использует подготовленный файл учётных данных с Argon2id hash. Для интеграции с PL задаются `MONITORING_ADMIN_AUTH_PROVIDER=gateway` и `MONITORING_ADMIN_GATEWAY_KEY_FILE` с индивидуальным raw32 ключом. В gateway mode каждый запрос проверяется по подписанному контракту PL; локальный fallback при ошибке подписи отсутствует. Shared UI загружается с `/ecosystem/` на origin PL, standalone использует собственные assets.

[Runtime layout и права](docs/production-layout.md) · [Контракт gateway](../websites-admin/docs/platform-integration.md)

Источник не содержит баз, credentials, production aliases или deployment overlays. Настройте trusted hosts, mounts, права и разрешённые host-agent операции для своей установки. Python tests запускаются через pytest в каталоге приложения; browser fixture обеих админок находится в `../websites-admin/tests/admin_shell_browser.test.mjs` и использует Playwright из frontend PL. Tests не запускают реальные restart или уведомления.
