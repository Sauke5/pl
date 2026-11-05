# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS gosu-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src/gosu
# Immutable upstream commit; checksum is of the entire source archive.
ADD --checksum=sha256:33d7537d588ea49458b9509bcf4554bdf5ceacc66da71e5caa1058ea3b689c3b https://codeload.github.com/tianon/gosu/tar.gz/6456aaa0f3c854d199d0f037f068eb97515b7513 /tmp/gosu.tar.gz
RUN tar -xzf /tmp/gosu.tar.gz --strip-components=1 -C /src/gosu && \
    rm /tmp/gosu.tar.gz && \
    go mod download && \
    go mod verify && \
    mkdir /out && \
    go build -mod=readonly -trimpath -buildvcs=false -ldflags='-d -w' -o /out/gosu . && \
    /out/gosu --version && \
    /out/gosu nobody id && \
    go version -m /out/gosu
# Keep symbol information, as upstream requires for binary vulnerability scanning.
# The archive contains no .git; exact source identity is recorded below instead
# of fabricating VCS/module-version metadata.

FROM postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
LABEL pl.component="postgresql" \
      pl.postgresql.version="18.6" \
      pl.gosu.version="1.19" \
      pl.gosu.source.revision="6456aaa0f3c854d199d0f037f068eb97515b7513" \
      pl.gosu.go.version="1.27.2"
COPY --from=gosu-build --chmod=0755 /out/gosu /usr/local/bin/gosu
COPY --from=gosu-build /src/gosu/LICENSE /usr/local/share/pl/postgresql/gosu.LICENSE
COPY deploy/images/postgres.sources.json /usr/local/share/pl/postgresql/sources.json
# Preserve upstream ENTRYPOINT, CMD, PGDATA, VOLUME, user and permissions.
# PostgreSQL 18 fresh installations mount /var/lib/postgresql, not a PG17 volume.
