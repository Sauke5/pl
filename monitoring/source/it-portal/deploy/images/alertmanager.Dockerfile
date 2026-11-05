# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Build context: monitoring/source/it-portal. CI alone builds/tests/scans.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOMAXPROCS=2 GOFLAGS=-p=2
WORKDIR /src
ADD --checksum=sha256:5c5c72ec6b4c4746d523f2ed1994dfec4b94f7457e530ee6fb16cfec158e545e https://codeload.github.com/prometheus/alertmanager/tar.gz/73c6bfe7393929211294c1954f30d8ed78e4d0ad /tmp/source.tar.gz
ADD --checksum=sha256:881fe0f7beb9573f35be47dd233af6220e72c8db72c03bcd1780402eb8dc1307 https://github.com/prometheus/alertmanager/releases/download/v0.34.1/alertmanager-web-ui-0.34.1.tar.gz /tmp/ui.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src && \
    tar -xzf /tmp/ui.tar.gz -C ui/app && \
    test -s ui/app/dist/index.html.gz && rm /tmp/source.tar.gz /tmp/ui.tar.gz && \
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
    mkdir -p /out/provenance /out/alertmanager-data /out/rootfs/etc/alertmanager /out/rootfs/tmp && \
    chmod 1777 /out/rootfs/tmp && touch /out/alertmanager-data/.pl-volume && cp go.mod go.sum /out/provenance/ && \
    go list -m all > /out/provenance/modules.txt && \
    go test -mod=readonly ./ui ./config && \
    go build -mod=readonly -trimpath -buildvcs=false -tags=netgo,osusergo \
      -ldflags='-s -w -X github.com/prometheus/common/version.Version=0.34.1 -X github.com/prometheus/common/version.Revision=73c6bfe7393929211294c1954f30d8ed78e4d0ad -X github.com/prometheus/common/version.Branch=HEAD -X github.com/prometheus/common/version.BuildUser=pl-source-build -X github.com/prometheus/common/version.BuildDate=20260917-081207' \
      -o /out/alertmanager ./cmd/alertmanager && \
    go build -mod=readonly -trimpath -buildvcs=false -tags=netgo,osusergo \
      -ldflags='-s -w -X github.com/prometheus/common/version.Version=0.34.1 -X github.com/prometheus/common/version.Revision=73c6bfe7393929211294c1954f30d8ed78e4d0ad -X github.com/prometheus/common/version.Branch=HEAD -X github.com/prometheus/common/version.BuildUser=pl-source-build -X github.com/prometheus/common/version.BuildDate=20260917-081207' \
      -o /out/amtool ./cmd/amtool && \
    go version -m /out/alertmanager > /out/provenance/alertmanager-build.txt && \
    go version -m /out/amtool > /out/provenance/amtool-build.txt && cp LICENSE /out/LICENSE
COPY deploy/images/alertmanager.sources.json /out/provenance/sources.json

FROM scratch AS alertmanager
COPY --from=build /out/rootfs/ /
COPY --from=build --chown=65534:65534 /out/alertmanager-data/ /alertmanager/
COPY --from=build /out/alertmanager /bin/alertmanager
COPY --from=build /out/amtool /bin/amtool
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/LICENSE /usr/share/licenses/alertmanager/LICENSE
COPY --from=build /out/provenance/ /usr/share/pl/provenance/alertmanager/
ENV PATH=/bin SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.version="0.34.1" \
      org.opencontainers.image.revision="73c6bfe7393929211294c1954f30d8ed78e4d0ad" \
      org.opencontainers.image.source="https://github.com/prometheus/alertmanager" \
      org.opencontainers.image.licenses="Apache-2.0" \
      pl.module.id="alertmanager" \
      pl.module.config.version="1" \
      pl.build.variant="source-build" \
      pl.build.go="1.27.2"
USER 65534:65534
WORKDIR /alertmanager
ENTRYPOINT ["/bin/alertmanager"]
CMD ["--config.file=/etc/alertmanager/config.json", "--storage.path=/alertmanager", "--web.listen-address=0.0.0.0:9093", "--cluster.listen-address=", "--data.retention=120h"]
