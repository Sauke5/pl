# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
ARG TARGETARCH
FROM python:3.15.0-slim@sha256:f5b92f2a669a4c347044f29367f31983280b648250ca94dea66f98c53bc87e58 AS adapter
ARG FORMS_VERSION=0.1.0
LABEL org.opencontainers.image.version="${FORMS_VERSION}" pl.module.id="forms" pl.module.role="adapter" pl.module.config.version="1" pl.build.variant="source-build"
# pip 26.2.2 replaces its vulnerable vendored certifi CA bundle (GHSA-6q48-6c7w-9gw2).
ADD --checksum=sha256:fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70 https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl /tmp/pip-26.2.2-py3-none-any.whl
RUN python -m pip install --no-cache-dir --no-index --no-deps /tmp/pip-26.2.2-py3-none-any.whl \
    && rm /tmp/pip-26.2.2-py3-none-any.whl
WORKDIR /app
RUN mkdir -p /data && chown 10001:10001 /data && chmod 0750 /data
COPY apps/forms/app.py apps/forms/gateway.py apps/forms/engine.py apps/forms/json_import.py apps/forms/analytics.py ./
COPY apps/forms/static/ ./static/
COPY deploy/images/forms.sources.json /usr/share/pl/provenance/forms/sources.json
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 FORMS_VERSION=${FORMS_VERSION} FORMS_PORT=8091 FORMS_DATABASE=/data/forms.sqlite3 FORMS_GATEWAY_KEY_FILE=/run/secrets/forms-gateway.key HEYFORM_CREDENTIALS_FILE=/run/secrets/forms-service.json HEYFORM_URL=http://heyform:9157 HEYFORM_WORKSPACE_NAME="Pl Forms" HEYFORM_PROJECT_NAME=Forms HEYFORM_TIMEOUT=10
USER 10001:10001
ENTRYPOINT ["python", "app.py"]

FROM heyform/community-edition:v3.0.5@sha256:3a103fa72d7ec8d94e8f0c44b009041fdd73d4ed35e3ed1b68ff7fe28520525e AS engine
ARG FORMS_VERSION=0.1.0
LABEL org.opencontainers.image.version="${FORMS_VERSION}" pl.module.id="forms" pl.module.role="engine" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="3.0.5"
USER 0:0
RUN mkdir -p /app/packages/server/static/upload && chown 10001:10001 /app/packages/server/static/upload && chmod 0750 /app/packages/server/static/upload
COPY apps/forms/engine-launcher.cjs /pl/forms-engine-launcher.cjs
COPY deploy/images/forms.sources.json /usr/share/pl/provenance/forms/sources.json
ENV NODE_ENV=production NODE_OPTIONS="--enable-source-maps --max-old-space-size=768" HOME=/tmp APP_HOMEPAGE_URL=http://heyform:9157 VERIFY_USER_EMAIL=false DISABLE_SUBMISSION_IP=true ENABLE_GOOGLE_FONTS=false MONGO_URI=mongodb://mongo:27017/plforms REDIS_HOST=keydb REDIS_PORT=6379 APP_DISABLE_REGISTRATION=true
WORKDIR /app/packages/server
USER 10001:10001
ENTRYPOINT ["node", "/pl/forms-engine-launcher.cjs"]
CMD []

FROM mongo:9.0.4@sha256:dc28ed5a9d0fc616903c3f463bb1e53b92b49f441721b91926e87d90bf957ce8 AS mongo
ARG FORMS_VERSION=0.1.0
LABEL org.opencontainers.image.version="${FORMS_VERSION}" pl.module.id="forms" pl.module.role="mongo" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="9.0.4"
USER 0:0
RUN mkdir -p /data/db /data/configdb && chown 999:999 /data/db /data/configdb
COPY deploy/images/forms.sources.json /usr/share/pl/provenance/forms/sources.json
USER 999:999
ENV HOME=/tmp
CMD ["mongod", "--bind_ip_all", "--wiredTigerCacheSizeGB", "0.25", "--quiet"]

FROM eqalpha/keydb:x86_64_v6.3.4@sha256:eceb1806730c7850395b8262300182c2e15a6e5dacbf0b72cbab110518caf43f AS keydb-amd64
FROM eqalpha/keydb:arm64_v6.3.4@sha256:acf2f4c443276bf071ab90861fd9644b22c9b6440e544fa655d287981dd8cd0a AS keydb-arm64
FROM keydb-${TARGETARCH} AS keydb
ARG FORMS_VERSION=0.1.0
LABEL org.opencontainers.image.version="${FORMS_VERSION}" pl.module.id="forms" pl.module.role="keydb" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="6.3.4"
USER 0:0
RUN mkdir -p /data && chown 10001:10001 /data && chmod 0750 /data
COPY deploy/images/forms.sources.json /usr/share/pl/provenance/forms/sources.json
USER 10001:10001
ENTRYPOINT ["keydb-server", "/run/secrets/forms-keydb.conf"]
CMD []
