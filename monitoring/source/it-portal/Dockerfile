# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
ARG GO_IMAGE=golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d
ARG NODE_IMAGE=node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
ARG NGINX_IMAGE=nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
FROM ${GO_IMAGE} AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/portal ./cmd/portal && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/executor ./cmd/executor

FROM ${GO_IMAGE} AS runtime-base
RUN addgroup -g 10001 portal && adduser -D -u 10001 -G portal portal && \
    mkdir -p /var/lib/pl/transfers && chown 10001:10001 /var/lib/pl/transfers && chmod 0700 /var/lib/pl/transfers
FROM runtime-base AS scanner-runtime
# TCP connect only, fixed arguments in providers/nmap.go; no raw socket caps.
RUN apk add --no-cache iperf3=3.20-r0 && \
    mkdir -p /scanner-root/usr/bin /scanner-root/usr/share && \
    cp /usr/bin/iperf3 /scanner-root/usr/bin/ && \
    for lib in $(ldd /usr/bin/iperf3 | awk '/=> \// {print $3} /^\t\// {print $1}'); do \
      mkdir -p "/scanner-root$(dirname "$lib")"; cp -L "$lib" "/scanner-root$lib"; \
    done

FROM scratch AS api
ENV ZONEINFO=/usr/local/go/lib/time/zoneinfo.zip
COPY --from=runtime-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=runtime-base /usr/local/go/lib/time/zoneinfo.zip /usr/local/go/lib/time/zoneinfo.zip
COPY --from=runtime-base /etc/passwd /etc/passwd
COPY --from=runtime-base /etc/group /etc/group
COPY --from=go-build /out/portal /portal
COPY --from=runtime-base --chown=10001:10001 --chmod=0700 /var/lib/pl/transfers /var/lib/pl/transfers
COPY --from=scanner-runtime /scanner-root/ /
COPY LICENSE NOTICE /usr/share/licenses/pl/
COPY THIRD_PARTY_NOTICES /usr/share/licenses/pl/THIRD_PARTY_NOTICES
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/portal"]

FROM scratch AS executor
COPY --from=runtime-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=go-build /out/executor /executor
ENTRYPOINT ["/executor"]

FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /src/frontend
RUN npm install --global npm@12.2.0
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/packages/pl-ui/ ./packages/pl-ui/
RUN npm ci
COPY frontend/ ./
COPY internal/model/resource-icons.json /src/internal/model/resource-icons.json
RUN npm run build
FROM ${NGINX_IMAGE} AS web
RUN apk add --no-cache --upgrade libexpat=2.10.0-r0 pcre2=10.49-r0 tiff=4.7.2-r0
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=frontend-build /src/frontend/dist/ /usr/share/nginx/html/
COPY LICENSE NOTICE THIRD_PARTY_NOTICES /usr/share/licenses/pl/
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
