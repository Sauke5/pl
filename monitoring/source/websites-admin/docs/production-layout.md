# Runtime layout websites-admin

Переносимый контракт PL; этот документ не описывает состояние production. Приложение остаётся отдельным standalone consumer вне native core delivery. Подготовка source не создаёт модуль или работающий стенд.

## Пути и доступ

| Назначение | Путь процесса | Доступ |
| --- | --- | --- |
| SQLite и config lock | `WEBSITES_ADMIN_DATA_DIR`, default `/app/data` | RW |
| Полные YAML snapshots | `WEBSITES_ADMIN_BACKUPS_DIR`, default `/app/backups/site-monitoring` | RW |
| HTTP targets | `WEBSITES_FILE`, default `/config/targets/websites.yml` | RW, с сохранением metadata |
| Content targets | `CONTENT_FILE`, default `/config/targets/content.yml` | RW |
| Blackbox modules | `BLACKBOX_FILE`, default `/config/blackbox/blackbox.yml` | RW, атомарная замена в каталоге |
| Индивидуальный raw32 gateway key | `WEBSITES_ADMIN_PLATFORM_SSO_KEY_FILE` | RO |
| Shared UI, standalone | `app/static/ecosystem/` | Точные копии PL assets |
| Shared UI, gateway | `/ecosystem/` origin Platform | Центральные assets |

Source не задаёт host bind roots, владельца установки или имена production пользователей. Перед восстановлением сверять реальные mounts, UID и полный snapshot всех трёх YAML. SQLite, secrets, логи, snapshots и live конфигурация не включаются в source package. Локальные тесты используют отдельные временные каталоги и моки сетевых действий.

Сохранить проверку YAML и Blackbox, bounded probe, атомарное применение, reload/read-back и rollback существующего apply flow. Ошибка уведомления не отменяет уже проверенную конфигурацию; ключ и адрес уведомлений поступают из private configuration текущей установки. Включение Telegram и реальная доставка проверяются только в разрешённой задаче.

`WEBSITES_ADMIN_TRUSTED_HOSTS` задаёт конечный список hostnames. Default разрешает лишь local/service/test aliases, публичное имя установки задаётся явно. Gateway проверяет `X-PL-Gateway-*`, `pl-gateway-v1\n`, audience, binding, scopes, CSRF и replay. Прямой unsigned upstream не получает доступ; gateway не переключается на standalone при отказе.

Для релиза сохранить effective конфигурацию и rollback, проверить prefix `/websites/`, static status/MIME/hash, форму и общий logout. Health и unit tests сами по себе не являются browser acceptance. Runtime rollout, users и secrets не изменяются при переносе UI source.
