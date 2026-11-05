# Runtime layout monitoring-admin

Переносимый контракт PL; это не протокол действующей установки. monitoring-admin и websites-admin — отдельные standalone приложения, они не входят в native core delivery. Наличие source и успешных локальных тестов не означает запуск web, worker или host-agent.

## Пути и доступ

| Объект | Путь процесса | Требуемый доступ |
| --- | --- | --- |
| SQLite, jobs, audit | `MONITORING_ADMIN_DATA_DIR`, default `/app/data` | Web и worker RW |
| Локальный provider с Argon2id hash | `MONITORING_ADMIN_CREDENTIALS_FILE` | Web RO, только standalone |
| Индивидуальный raw 32-byte gateway key | `MONITORING_ADMIN_GATEWAY_KEY_FILE` | Web RO, только gateway |
| Host-agent socket | `MONITORING_ADMIN_AGENT_SOCKET`, default `/run/monitoring-admin/agent.sock` | Только согласованные фиксированные операции |
| Browser UI в standalone mode | `app/static/ecosystem/` | Точные копии shared PL assets |
| Browser UI в gateway mode | `/ecosystem/` на origin Platform | Центральные assets, без зависимости от standalone копии |

Host bind sources, UID/GID и владельца systemd unit выбирает установка; адресов, production aliases и секретов в source нет. Web/worker не получают Docker socket. Host-agent имеет собственный allowlist; HTTP не может передать произвольную команду, путь или имя контейнера. Service allowlist не расширять ради смены UI.

## Проверка установки

До apply проверить effective конфигурацию, mounts и доступ к файлам от реального UID без вывода содержимого. Сохранить используемые images, конфигурацию и rollback. Не считать mode файла достаточным доказательством чтения ключа. Размещение private provider и данных не должно попадать в source export.

Gateway режим использует только `X-PL-Gateway-Assertion`, `X-PL-Gateway-Signature`, HMAC domain `pl-gateway-v1\n` и конечные routes/scopes. Неверная подпись не включает local fallback. Проверять браузерный prefix `/admin/`, общий выход, assets status/MIME/hash и предметные действия отдельно от health. Standalone локальные сессии сохраняются как отдельный режим.

`MONITORING_ADMIN_TRUSTED_HOSTS` задаёт явные hostnames установки. Default содержит только local/service/test aliases; wildcard и адрес конкретной организации по умолчанию отсутствуют. Выкладка и изменение host-agent/прав выполняются отдельно в разрешённом окружении.
