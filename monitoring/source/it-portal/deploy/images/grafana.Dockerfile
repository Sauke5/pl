# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Official OSS binaries and bundled plugins retain their native signatures.
FROM grafana/grafana:13.3.0@sha256:488984b716c0862639f91a698adbe2862677a5a07bad42da5f03f3030883b205 AS grafana
LABEL org.opencontainers.image.version="13.3.0" \
      org.opencontainers.image.revision="6f8ce3c693b493043ebcd4787566d2b6b118b0f0" \
      org.opencontainers.image.source="https://github.com/grafana/grafana" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      pl.module.id="grafana" \
      pl.module.config.version="1" \
      pl.build.variant="upstream-pinned"
USER 472:0
