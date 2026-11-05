# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
FROM python:3.15.0-slim-trixie@sha256:2da676046630d7bf14c6764ae1143dc7fa0377a53f94bf5a642f0b214aca5bce AS server
ARG INVENTORY_VERSION=1.0.0
LABEL pl.module.id="inventory" pl.module.role="server" pl.module.config.version="1" \
      pl.build.variant="source-build" org.opencontainers.image.version="${INVENTORY_VERSION}"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 INVENTORY_AUTH_MODE=gateway \
    INVENTORY_DATA_DIR=/data INVENTORY_GATEWAY_KEY_FILE=/run/secrets/inventory/gateway.key \
    INVENTORY_ARCHIVE_PASSWORD_FILE=/run/secrets/inventory/archive-password
WORKDIR /app
COPY apps/inventory/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home inventory
COPY apps/inventory/inventory_service ./inventory_service
COPY apps/inventory/web ./web
COPY apps/inventory/LICENSE /usr/share/licenses/inventory/LICENSE
COPY deploy/images/inventory.sources.json /usr/share/pl/provenance/inventory/sources.json
USER 10001:10001
EXPOSE 8587
CMD ["python", "-m", "uvicorn", "inventory_service.app:app", "--host", "0.0.0.0", "--port", "8587", "--workers", "1", "--no-access-log"]
