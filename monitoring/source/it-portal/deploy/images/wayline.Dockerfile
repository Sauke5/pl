# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Build context: isolated release root. Targets: api, runner, gateway.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS backend
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOFLAGS=-p=2
WORKDIR /src
COPY apps/wayline/backend/go.mod apps/wayline/backend/go.sum ./
RUN go mod download && go mod verify
COPY apps/wayline/backend/ ./
ARG WAYLINE_VERSION=0.1.0
RUN mkdir -p /out /data && chown 10001:10001 /data && chmod 0750 /data && \
    go build -mod=readonly -trimpath -buildvcs=false -ldflags="-X main.version=${WAYLINE_VERSION}" -o /out/wayline ./cmd/wayline && \
    go build -mod=readonly -trimpath -buildvcs=false -o /out/wayline-runner ./cmd/wayline-runner && \
    go list -m -json all > /out/modules.json && go version -m /out/wayline > /out/api-build.txt && \
    go version -m /out/wayline-runner > /out/runner-build.txt && \
    mkdir -p /runner-root/etc && cp -a /etc/apk /runner-root/etc/ && \
    apk --root /runner-root --initdb --no-cache add alpine-baselayout busybox ca-certificates iputils mtr iperf3 tzdata && \
    apk --root /runner-root info -vv > /out/runner-packages.txt

FROM scratch AS api
ARG WAYLINE_VERSION=0.1.0
LABEL org.opencontainers.image.version="${WAYLINE_VERSION}" pl.module.id="wayline" pl.module.role="api" pl.module.config.version="1" pl.build.variant="source-build" pl.build.go="1.27.2"
COPY --from=backend /out/wayline /usr/local/bin/wayline
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=backend --chown=10001:10001 /data /data
COPY --from=backend /out/modules.json /out/api-build.txt /usr/share/pl/provenance/wayline/
ENV WAYLINE_HTTP_ADDR=:8080 WAYLINE_DB_PATH=/data/wayline.db WAYLINE_DEPLOYMENT_MODE=platform WAYLINE_RUNNER_URL=http://wayline-runner:8081 WAYLINE_RUNNER_TOKEN_FILE=/run/secrets/runner-token
USER 10001:10001
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/wayline"]

FROM scratch AS runner
ARG WAYLINE_VERSION=0.1.0
LABEL org.opencontainers.image.version="${WAYLINE_VERSION}" pl.module.id="wayline" pl.module.role="runner" pl.module.config.version="1" pl.build.variant="source-build" pl.build.go="1.27.2"
COPY --from=backend /runner-root/ /
COPY --from=backend /out/wayline-runner /usr/local/bin/wayline-runner
COPY --from=backend /out/modules.json /out/runner-build.txt /out/runner-packages.txt /usr/share/pl/provenance/wayline/
ENV WAYLINE_RUNNER_ADDR=:8081 WAYLINE_DEPLOYMENT_MODE=platform WAYLINE_RUNNER_TOKEN_FILE=/run/secrets/runner-token WAYLINE_RUNNER_CONCURRENCY=4
USER 0:10001
ENTRYPOINT ["/usr/local/bin/wayline-runner"]

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS frontend
WORKDIR /src
COPY apps/wayline/web/package.json apps/wayline/web/package-lock.json ./
COPY apps/wayline/web/vendor/ ./vendor/
RUN npm ci
COPY apps/wayline/web/ ./
ENV VITE_BASE_PATH=/wayline/ VITE_PLATFORM_AUTH=true VITE_PLATFORM_URL=""
RUN npm run build

FROM nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5 AS gateway
RUN apk add --upgrade --no-cache libexpat=2.10.0-r0
ARG WAYLINE_VERSION=0.1.0
LABEL org.opencontainers.image.version="${WAYLINE_VERSION}" pl.module.id="wayline" pl.module.role="gateway" pl.module.config.version="1" pl.build.variant="source-build"
COPY apps/wayline/deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=frontend --chown=nginx:nginx /src/dist/ /usr/share/nginx/html/
USER nginx
WORKDIR /usr/share/nginx/html
ENTRYPOINT ["nginx", "-g", "daemon off;"]
