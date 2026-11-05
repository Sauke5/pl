# Gateway assertion v2 для Auditor

Поддерживаемые префиксы: `/audit/` и `/audit-arch/`. Backend получает исходный URI с префиксом. `aud` равен `auditor`. Для каждого сервера используется свой внешний файл с 32 случайными байтами (`Gateway:KeyFile`).

Gateway удаляет входящие `X-PL-Gateway-Assertion` и `X-PL-Gateway-Signature`, затем подписывает запрос после проверки сессии Платформы. Подпись: `base64url(HMAC-SHA256(key, ASCII("pl-gateway-v2\n" + assertion)))`, где `assertion` — `base64url(UTF8(JSON claims))`, без padding. Подписанный `uri` должен точно совпасть с сырым request target, включая порядок и encoding query-параметров.

GET/HEAD: `admin=false`, `scopes=["auditor:read"]` для обычного пользователя. Администратор Платформы: `admin=true`, `scopes=["auditor:read","auditor:scan"]`. Единственная операция изменения — `POST <prefix>/api/scans`. Для неё обязательны `csrf_verified=true`, совпадающий `X-CSRF-Token`, новый nonce и SHA-256 фактического body. `iat`/`exp` — Unix seconds, срок до 30 секунд. `content_type`, `idempotency_key`, `method`, `uri`, `body_sha256` привязаны к заголовкам и body. `source_ip` — IP клиента, определённый доверенным gateway.

Тестовый вектор ниже использует **публичный фиктивный ключ** `000102...1f`; время claims фиксировано только для сравнения подписи.

```json
{
  "v": 2,
  "aud": "auditor",
  "iat": 1791400000,
  "exp": 1791400030,
  "nonce": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  "sub": "portal-user-1",
  "name": "Test User",
  "admin": false,
  "scopes": [
    "auditor:read"
  ],
  "method": "GET",
  "uri": "/audit/api/instance",
  "content_type": "",
  "body_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "idempotency_key": "",
  "source_ip": "192.0.2.10",
  "csrf_token": "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
  "csrf_verified": false
}
```

```text
X-PL-Gateway-Assertion: eyJ2IjoyLCJhdWQiOiJhdWRpdG9yIiwiaWF0IjoxNzkxNDAwMDAwLCJleHAiOjE3OTE0MDAwMzAsIm5vbmNlIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVhHQmthR3h3ZEhoOCIsInN1YiI6InBvcnRhbC11c2VyLTEiLCJuYW1lIjoiVGVzdCBVc2VyIiwiYWRtaW4iOmZhbHNlLCJzY29wZXMiOlsiYXVkaXRvcjpyZWFkIl0sIm1ldGhvZCI6IkdFVCIsInVyaSI6Ii9hdWRpdC9hcGkvaW5zdGFuY2UiLCJjb250ZW50X3R5cGUiOiIiLCJib2R5X3NoYTI1NiI6ImUzYjBjNDQyOThmYzFjMTQ5YWZiZjRjODk5NmZiOTI0MjdhZTQxZTQ2NDliOTM0Y2E0OTU5OTFiNzg1MmI4NTUiLCJpZGVtcG90ZW5jeV9rZXkiOiIiLCJzb3VyY2VfaXAiOiIxOTIuMC4yLjEwIiwiY3NyZl90b2tlbiI6IlFFRkNRMFJGUmtkSVNVcExURTFPVDFCUlVsTlVWVlpYV0ZsYVcxeGRYbDgiLCJjc3JmX3ZlcmlmaWVkIjpmYWxzZX0
X-PL-Gateway-Signature: TBJGHrQ7VIYGfjvcOC5tKEzTPd5-clIM7km77_xrfaA
```

Реализация проверки: `src/Auditor.Api/Auth/GatewayAssertionVerifier.cs`. Подробные негативные случаи: `tests/Auditor.Tests/Api/GatewayAssertionTests.cs`.
