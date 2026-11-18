# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
FROM docker.io/victoriametrics/victoria-logs:v1.54.0@sha256:ee4e820cac3721f5f5d91641b950c22439593adc4224f9655e5333d5a84c1dfe AS server
LABEL org.opencontainers.image.version="1.54.0" \
      pl.upstream.version="1.54.0" \
      pl.module.id="syslog" \
      pl.module.role="server" \
      pl.module.config.version="1" \
      pl.build.variant="upstream-pinned"
COPY deploy/images/syslog.sources.json /usr/share/pl/provenance/syslog/sources.json
COPY deploy/images/syslog.LICENSE /usr/share/pl/provenance/syslog/LICENSE
USER 65532:65532
WORKDIR /victoria-logs-data
