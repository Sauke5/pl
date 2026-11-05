# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
FROM drakkan/sftpgo:v2.7.6@sha256:1edd28d80de2a008863fbfc58c8ff7db47b1b410bae48d4e6076192337809b11 AS server
ARG SFTPGO_VERSION=2.7.6
LABEL org.opencontainers.image.version="${SFTPGO_VERSION}" pl.module.id="sftpgo" pl.module.role="server" pl.module.config.version="1" pl.build.variant="upstream-pinned"
USER 0:0
RUN mkdir -p /var/lib/sftpgo /srv/sftpgo/data/users /srv/sftpgo/data/shared /srv/sftpgo/backups && chown -R 1000:1000 /var/lib/sftpgo /srv/sftpgo && chmod 0750 /var/lib/sftpgo /srv/sftpgo /srv/sftpgo/data /srv/sftpgo/data/users /srv/sftpgo/data/shared && chmod 0700 /srv/sftpgo/backups
COPY deploy/images/sftpgo.sources.json /usr/share/pl/provenance/sftpgo/sources.json
WORKDIR /var/lib/sftpgo
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/sftpgo"]
CMD ["serve", "--config-dir", "/etc/pl-sftpgo", "--config-file", "sftpgo.json", "--loaddata-from", "/etc/pl-sftpgo/bootstrap.json", "--loaddata-mode", "1", "--log-file-path", ""]
