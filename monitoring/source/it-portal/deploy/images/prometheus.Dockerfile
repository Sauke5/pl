# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Build context: monitoring/source/it-portal. CI owns build/test/scan execution.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOMAXPROCS=2 GOFLAGS=-p=2
WORKDIR /src
# Both upstream archives are immutable inputs, checked before extraction.
RUN wget -q -O /tmp/source.tar.gz https://codeload.github.com/prometheus/prometheus/tar.gz/5241a27fe3c6983549fccc32f6e65917408c63cd && \
    echo 'eee7ec029ffdba7d9ee59171cad5ddaff10e71514b0bae1a6fde6dc1ae99e181  /tmp/source.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src && \
    wget -q -O /tmp/ui.tar.gz https://github.com/prometheus/prometheus/releases/download/v3.15.0/prometheus-web-ui-3.15.0.tar.gz && \
    echo 'fa8c918ed05e3f89e232e9b69eccd6ed074602cd9e8a2cab7a92bec9651974ae  /tmp/ui.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/ui.tar.gz -C web/ui && \
    rm /tmp/source.tar.gz /tmp/ui.tar.gz
COPY deploy/images/prometheus-embed-assets.sh /tmp/embed-assets.sh
# Equivalent to upstream assets-compress, without installing unpinned bash/make.
RUN sh /tmp/embed-assets.sh && \
    test -s web/ui/static/mantine-ui/index.html.gz && \
    test -s web/ui/static/react-app/index.html.gz
# This single bounded dependency update deterministically selects x/net's immutable
# transitive module requirements. Public sumdb remains enabled; no replace/ignore.
# The complete selected graph and resulting checksummed locks ship in provenance.
RUN go get golang.org/x/net@v0.61.0 && go mod download && go mod verify && \
    grep -Fxq 'golang.org/x/net v0.61.0 h1:RR+6j/BTBCrggOLugxa+66R8FvoN6MHlzDlZIbN9YFw=' go.sum && \
    grep -Fxq 'golang.org/x/net v0.61.0/go.mod h1:WgDCOTH8iwtB66T4/GfI94AHo/hhdb7Hah9NDseQfiI=' go.sum && \
    mkdir -p /out/provenance && cp go.mod go.sum /out/provenance/ && \
    go list -m all > /out/provenance/modules.txt && \
    test "$(go list -m -f '{{.Version}}' golang.org/x/net)" = v0.61.0
RUN go test -mod=readonly -tags=netgo,builtinassets ./web/ui && \
    go build -mod=readonly -trimpath -buildvcs=false -tags=netgo,builtinassets \
      -ldflags='-s -w -X github.com/prometheus/common/version.Version=3.15.0 -X github.com/prometheus/common/version.Revision=5241a27fe3c6983549fccc32f6e65917408c63cd -X github.com/prometheus/common/version.Branch=HEAD -X github.com/prometheus/common/version.BuildUser=pl-security-rebuild -X github.com/prometheus/common/version.BuildDate=20260925-085622' \
      -o /out/prometheus ./cmd/prometheus && \
    go build -mod=readonly -trimpath -buildvcs=false -tags=netgo,builtinassets \
      -ldflags='-s -w -X github.com/prometheus/common/version.Version=3.15.0 -X github.com/prometheus/common/version.Revision=5241a27fe3c6983549fccc32f6e65917408c63cd -X github.com/prometheus/common/version.Branch=HEAD -X github.com/prometheus/common/version.BuildUser=pl-security-rebuild -X github.com/prometheus/common/version.BuildDate=20260925-085622' \
      -o /out/promtool ./cmd/promtool && \
    go version -m /out/prometheus > /out/provenance/prometheus-build.txt && \
    go version -m /out/promtool > /out/provenance/promtool-build.txt
COPY deploy/images/prometheus.sources.json /out/provenance/sources.json

# Keep the upstream runtime, trust store, UID, command and TSDB conventions.
# Both vulnerable Go executables are replaced, including promtool.
FROM prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e AS prometheus
COPY --from=build /out/prometheus /bin/prometheus
COPY --from=build /out/promtool /bin/promtool
COPY --from=build /out/provenance/ /usr/share/pl/provenance/prometheus/
LABEL org.opencontainers.image.version="3.15.0" \
      org.opencontainers.image.revision="5241a27fe3c6983549fccc32f6e65917408c63cd" \
      org.opencontainers.image.source="https://github.com/prometheus/prometheus" \
      pl.module.id="prometheus" \
      pl.module.config.version="1" \
      pl.build.variant="security-rebuild" \
      pl.build.go="1.27.2" \
      pl.build.x-net="v0.61.0"
