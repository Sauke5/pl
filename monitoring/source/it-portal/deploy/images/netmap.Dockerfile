# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Context: isolated release root. Fixed upstream index digests; no live state.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS gosu-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src/gosu
ADD --checksum=sha256:33d7537d588ea49458b9509bcf4554bdf5ceacc66da71e5caa1058ea3b689c3b https://codeload.github.com/tianon/gosu/tar.gz/6456aaa0f3c854d199d0f037f068eb97515b7513 /tmp/gosu.tar.gz
RUN tar -xzf /tmp/gosu.tar.gz --strip-components=1 -C /src/gosu && go mod download && go mod verify && mkdir /out && go build -mod=readonly -trimpath -buildvcs=false -ldflags='-d -w' -o /out/gosu .
FROM postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 AS database
LABEL org.opencontainers.image.version="1.2.3" pl.module.id="netmap" pl.module.role="database" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="18.6" pl.gosu.version="1.19" pl.gosu.source.revision="6456aaa0f3c854d199d0f037f068eb97515b7513"
COPY --from=gosu-build --chmod=0755 /out/gosu /usr/local/bin/gosu
COPY --from=gosu-build /src/gosu/LICENSE /usr/share/pl/gosu.LICENSE

FROM valkey/valkey:9.1-alpine@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b AS cache
LABEL org.opencontainers.image.version="1.2.3" pl.module.id="netmap" pl.module.role="cache" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="9.1"
COPY --chmod=0755 apps/netmap-stack/cache-start.sh /opt/pl/cache-start.sh
ENTRYPOINT ["/opt/pl/cache-start.sh"]

FROM netboxcommunity/netbox:v4.7.4-5.1.1@sha256:c75a7dcfe61dadd4e009c9b5d9118a33bec991f4359c0db18ac7f287b5980246 AS netbox-base
COPY apps/netmap-stack/netbox-extra.py /etc/netbox/config/configuration.py
COPY apps/netmap-stack/netbox-bootstrap.py /opt/pl/netbox-bootstrap.py
COPY --chmod=0755 apps/netmap-stack/netbox-start.sh /opt/pl/netbox-start.sh
USER 999:0
FROM netbox-base AS netbox
LABEL org.opencontainers.image.version="1.2.3" pl.module.id="netmap" pl.module.role="netbox" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="4.7.4" pl.netbox-docker.version="5.1.1"
ENTRYPOINT ["/opt/pl/netbox-start.sh"]
CMD []
FROM netbox-base AS netbox-worker
LABEL org.opencontainers.image.version="1.2.3" pl.module.id="netmap" pl.module.role="netbox-worker" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="4.7.4" pl.netbox-docker.version="5.1.1"
ENTRYPOINT ["/opt/pl/netbox-start.sh", "--worker"]
CMD []

FROM gitea/gitea:28.2.0-rootless@sha256:94807314454f6525994a3b76286ba12bc7e7f8cd14f61d9e67431767f8103306 AS gitea
LABEL org.opencontainers.image.version="1.2.3" pl.module.id="netmap" pl.module.role="gitea" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="28.2.0"
COPY --chmod=0755 apps/netmap-stack/gitea-start.sh /opt/pl/gitea-start.sh
USER 1000:1000
ENTRYPOINT ["/opt/pl/gitea-start.sh"]
CMD []

FROM oxidized/oxidized:0.37.0@sha256:07d8d7d669bb210b1100d121bbe214a3d64d621b1768f8f2179a1508a772541e AS oxidized
LABEL org.opencontainers.image.version="1.2.3" pl.module.id="netmap" pl.module.role="oxidized" pl.module.config.version="1" pl.build.variant="upstream-pinned" pl.upstream.version="0.37.0"
COPY apps/netmap-stack/oxidized-start.rb apps/netmap-stack/known-hosts-source.rb /opt/pl/
USER 30000:30000
ENTRYPOINT ["ruby", "/opt/pl/oxidized-start.rb"]
CMD []

FROM python:3.15.0-slim@sha256:f5b92f2a669a4c347044f29367f31983280b648250ca94dea66f98c53bc87e58 AS adapter
LABEL org.opencontainers.image.version="1.2.3" pl.module.id="netmap" pl.module.role="adapter" pl.module.config.version="1" pl.build.variant="source-build"
RUN apt-get update && apt-get install -y --no-install-recommends snmp ca-certificates iputils-ping && rm -rf /var/lib/apt/lists/* && mkdir -p /data && chown 10001:10001 /data
COPY apps/netmap-stack/inventory-requirements.txt /opt/pl/inventory-requirements.txt
RUN python3 -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/pl/inventory-requirements.txt
COPY apps/netmap/ /opt/netmap/
COPY apps/netmap-stack/ /opt/pl/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NETMAP_DATA_DIR=/data/map
USER 10001:10001
WORKDIR /data
ENTRYPOINT ["python3", "/opt/pl/service.py"]
