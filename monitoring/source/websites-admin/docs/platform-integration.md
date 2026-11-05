# Gateway standalone-админок PL

Monitoring Admin публикуется под `/admin/`, Websites Admin — под `/websites/`. Это отдельные сервисы: их source не создаёт runtime route или доступ автоматически. Портал проверяет текущую admin session и Origin/CSRF, затем подписывает точные method, raw URI/query, body hash, content type и idempotency key.

Headers: `X-PL-Gateway-Assertion`, `X-PL-Gateway-Signature`. HMAC domain — `pl-gateway-v1\n` с настоящим LF. Каждая админка получает собственный ключ из 32 raw bytes через read-only файл. Публичный контракт и общие тестовые vectors находятся в `it-portal/docs/platform-sso-contract.md` и `it-portal/docs/examples/admin-v1-vectors.json`.

Gateway проверяет audience/scopes, TTL, подпись, method/path/body binding, derived CSRF и replay. Он не принимает локальную session как замену подписи. Unsafe nonce cache ограничен одним процессом/репликой; persistent operation tokens и jobs сохраняют отдельную idempotency-защиту. Не включайте fallback с gateway на standalone при ошибке авторизации.

В gateway mode UI использует центральные `/ecosystem/` assets и общий POST `/auth/logout`. Исходная cookie и portal CSRF не передаются upstream. Standalone mode использует собственный вход и выход. Развёртывание должно согласованно настроить prefix, proxy, individual key, trusted hosts и права чтения ключа; source tests не подтверждают пользовательский сценарий конкретной установки.
