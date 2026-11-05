# Monitoring Admin host agent

Minimal root-side adapter used by Monitoring Admin. It exposes a small HTTP API
over a systemd-owned Unix socket and translates fixed service identifiers to a
hard-coded Docker container registry.

It deliberately has no generic command endpoint. Request bodies cannot contain
commands, arguments, container names, filesystem paths, or shell fragments.

## API

- `GET /v1/overview`
- `GET /v1/services/{service_id}`
- `GET /v1/services/{service_id}/logs?tail=50`
- `POST /v1/services/{service_id}/restart` with `{"request_id":"..."}`

Only `tail=50` is accepted. `nginx`, `monitoring-admin`, and
`monitoring-admin-worker` are intentionally not restartable.

The systemd service is socket-activated. Production access is controlled by the
mode and group of `/run/monitoring-admin/agent.sock`.
