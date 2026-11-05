# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Build context: monitoring/source/it-portal. CI builds, scans and tests the image.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOMAXPROCS=2 GOFLAGS=-p=2
WORKDIR /src
# v26.3.27 is the stable release; pin its Git commit, not a mutable branch/tag.
# Rebuild stable upstream code with four exact security dependency updates.
# Preserve public sumdb verification and emit the complete final module graph.
ADD --checksum=sha256:14fa566ee0a801d3d51144c67018b449f5dcf462ddfacadd032da069787e61f9 https://codeload.github.com/XTLS/Xray-core/tar.gz/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0 /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src && \
    rm /tmp/source.tar.gz && \
    go get golang.org/x/crypto@v0.58.0 golang.org/x/net@v0.61.0 golang.org/x/text@v0.43.0 google.golang.org/grpc@v1.84.0 && \
    go mod download && go mod verify && \
    grep -Fxq 'golang.org/x/crypto v0.58.0 h1:COkYLr4k7nDI4r6QtMML2AfzeIswWHAJthLS6K/M/54=' go.sum && \
    grep -Fxq 'golang.org/x/crypto v0.58.0/go.mod h1:Xh+kl5A+M0gMiWDytH2Hhr5Z7WbNCpv/eB/EFgfSk+w=' go.sum && \
    test "$(go list -m -f '{{.Version}}' golang.org/x/crypto)" = v0.58.0 && \
    grep -Fxq 'golang.org/x/net v0.61.0 h1:RR+6j/BTBCrggOLugxa+66R8FvoN6MHlzDlZIbN9YFw=' go.sum && \
    grep -Fxq 'golang.org/x/net v0.61.0/go.mod h1:WgDCOTH8iwtB66T4/GfI94AHo/hhdb7Hah9NDseQfiI=' go.sum && \
    test "$(go list -m -f '{{.Version}}' golang.org/x/net)" = v0.61.0 && \
    grep -Fxq 'golang.org/x/text v0.43.0 h1:1QivrlhwAsnMOcqgOdl9my7s9OyZl8O5/UGUTJVXoWc=' go.sum && \
    grep -Fxq 'golang.org/x/text v0.43.0/go.mod h1:hbSIYA/amXcRXTFSZqh8tWHEoqRvvbKPJ2uz/KU+a+s=' go.sum && \
    test "$(go list -m -f '{{.Version}}' golang.org/x/text)" = v0.43.0 && \
    grep -Fxq 'google.golang.org/grpc v1.84.0 h1:soMyaPJ8pAak5PIQ0DGBUir0XRo2fRoMqhNWMLlLxO0=' go.sum && \
    grep -Fxq 'google.golang.org/grpc v1.84.0/go.mod h1:ljCht0DrxQrXBDRTZp52Qxh3Ffk8CdYm2sj4O2QN2C0=' go.sum && \
    test "$(go list -m -f '{{.Version}}' google.golang.org/grpc)" = v1.84.0 && \
    mkdir -p /out/provenance /out/rootfs/etc/xray /out/rootfs/usr/share/xray /out/rootfs/tmp && \
    chmod 1777 /out/rootfs/tmp && \
    cp go.mod go.sum /out/provenance/ && \
    go list -m all > /out/provenance/modules.txt && \
    go build -mod=readonly -trimpath -buildvcs=false -tags=netgo,osusergo \
      -ldflags='-s -w -buildid= -X github.com/xtls/xray-core/core.build=pl-d2758a0' \
      -o /out/xray ./main && \
    /out/xray version && \
    go version -m /out/xray > /out/provenance/xray-build.txt && \
    cp LICENSE /out/LICENSE
COPY deploy/images/xray.sources.json /out/provenance/sources.json

# A static non-root runtime: no package manager, shell, daemon or downloaded geo files.
# The finite private_direct policy uses literal CIDRs, not geoip/geosite databases.
FROM scratch AS xray
COPY --from=build /out/rootfs/ /
COPY --from=build --chmod=0755 /out/xray /usr/local/bin/xray
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/LICENSE /usr/share/licenses/xray/LICENSE
COPY --from=build /out/provenance/ /usr/share/pl/provenance/xray/
ENV PATH=/usr/local/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    XRAY_LOCATION_ASSET=/usr/share/xray \
    XRAY_LOCATION_CONFIG=/etc/xray
LABEL org.opencontainers.image.version="26.3.27" \
      org.opencontainers.image.revision="d2758a023cd7f4174a5a5fa4ff66e487d4342ba0" \
      org.opencontainers.image.source="https://github.com/XTLS/Xray-core" \
      org.opencontainers.image.licenses="MPL-2.0" \
      pl.module.id="xray" \
      pl.module.config.version="1" \
      pl.build.variant="source-build" \
      pl.build.go="1.27.2"
USER 65534:65534
WORKDIR /etc/xray
ENTRYPOINT ["/usr/local/bin/xray"]
CMD ["run", "-config", "/etc/xray/config.json"]
