# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Context: isolated release root. PostgreSQL uses the exact core image separately.
FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS dependencies
RUN npm install --global pnpm@10.32.1
WORKDIR /app
COPY apps/doska/ ./
ENV HUSKY=0
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
ENV VITE_BASE_PATH=/doska/ VITE_DOSKA_MODE=platform VITE_API_URL=/doska/api
RUN pnpm --filter @kaneo/email --filter @kaneo/permissions --filter @kaneo/importers --filter @kaneo/mcp run build && \
    pnpm --filter @kaneo/api run build && pnpm --filter @kaneo/web run build && node deploy/generate-manifest.mjs

FROM build AS production-dependencies
RUN pnpm --filter @kaneo/api --prod deploy --legacy /production
# This dependency ships public signing-key test fixtures in its npm tarball.
# Its runtime entry points use lib/, not test/; retain the runtime and license.
RUN find /production/node_modules -type d -path '*/universal-github-app-jwt/test' -prune -exec rm -rf '{}' +

FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS api
ARG DOSKA_VERSION=2.46.2
LABEL org.opencontainers.image.version="${DOSKA_VERSION}" pl.module.id="doska" pl.module.role="api" pl.module.config.version="1" pl.build.variant="source-build"
RUN addgroup -g 10001 app && adduser -u 10001 -G app -D app && \
    mkdir -p /app/data/attachments && chown -R app:app /app
COPY --from=production-dependencies --chown=app:app /production/ /app/
COPY --from=build --chown=app:app /app/apps/api/dist/ /app/dist/
COPY --from=build --chown=app:app /app/apps/api/drizzle/ /app/drizzle/
ENV NODE_ENV=production DOSKA_AUTH_MODE=platform DOSKA_ATTACHMENTS_DIRECTORY=/app/data/attachments \
    DOSKA_GATEWAY_KEY_FILE=/run/secrets/gateway_key DOSKA_DIRECTORY_TOKEN_FILE=/run/secrets/directory_token \
    AUTH_SECRET_FILE=/run/secrets/auth_secret POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
    POSTGRES_HOST=database POSTGRES_DB=doska POSTGRES_USER=doska \
    NODE_EXTRA_CA_CERTS=/run/secrets/platform-ca.crt
USER 10001:10001
WORKDIR /app
EXPOSE 1337
ENTRYPOINT ["node", "dist/index.js"]

FROM nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5 AS web
RUN apk add --upgrade --no-cache libexpat=2.10.0-r0 pcre2=10.49-r0 tiff=4.7.2-r0
ARG DOSKA_VERSION=2.46.2
LABEL org.opencontainers.image.version="${DOSKA_VERSION}" pl.module.id="doska" pl.module.role="web" pl.module.config.version="1" pl.build.variant="source-build"
COPY apps/doska/deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=nginx:nginx /app/apps/web/dist/ /usr/share/nginx/html/doska/
COPY --from=build --chown=nginx:nginx /app/deploy/gateway-manifest.built.json /usr/share/pl/doska/gateway-manifest.json
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
