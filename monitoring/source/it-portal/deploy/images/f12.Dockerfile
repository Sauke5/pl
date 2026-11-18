FROM --platform=$BUILDPLATFORM docker.io/library/python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS prepare
ARG TARGETARCH
WORKDIR /recipe
COPY deploy/images/f12-origin.py deploy/images/f12-sources.py deploy/images/f12-runtime.json ./
RUN python3 f12-sources.py runtime --architecture "$TARGETARCH" --output /inputs
RUN --network=none python3 f12-origin.py /inputs /source.tar.gz
RUN --network=none python3 -m pip install --disable-pip-version-check --no-deps --no-index --no-compile \
    --target /python /inputs/python/pycdlib-1.22.0-py3-none-any.whl

FROM --platform=$BUILDPLATFORM docker.io/library/python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS windows-inputs
ARG BUILDARCH
WORKDIR /recipe
COPY deploy/images/f12-sources.py deploy/images/f12-runtime.json ./
RUN python3 f12-sources.py windows-build --architecture "$BUILDARCH" --output /inputs

FROM --platform=$BUILDPLATFORM docker.io/library/python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS windows-toolchain
RUN --network=none --mount=type=bind,from=windows-inputs,source=/inputs,target=/tmp/pl-debs \
    apt-get -y --no-install-recommends install /tmp/pl-debs/*.deb && \
    command -v i686-w64-mingw32-gcc && command -v x86_64-w64-mingw32-gcc

FROM windows-toolchain AS windows-guest
WORKDIR /src
COPY apps/f12/strelec/media.c apps/f12/strelec/iso_http.c apps/f12/strelec/iso_http.h apps/f12/strelec/build.sh apps/f12/strelec/winpeshl.ini ./
RUN --network=none sh build.sh /out && install -m 0444 winpeshl.ini /out/winpeshl.ini && chmod 0444 /out/*.exe

# Both F12 host architectures serve the same x86 PC BIOS loader.
FROM --platform=linux/amd64 docker.io/library/golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS strelec-bios-amd64
WORKDIR /src
COPY deploy/images/f12-wimboot-e587564.tar.gz deploy/images/f12-wimboot-sstr.patch /recipe/
RUN --network=none echo "7c1f0216ecf66e5a2e6afe0bcfa01bca82399a7c749e5a44f3495083a6b8b54d  /recipe/f12-wimboot-e587564.tar.gz" | sha256sum -c - && \
    tar -xzf /recipe/f12-wimboot-e587564.tar.gz --strip-components=1 && git apply --unidiff-zero /recipe/f12-wimboot-sstr.patch && \
    make -j2 -C src wimboot.i386.unsigned && install -D -m 0444 src/wimboot.i386.unsigned /out/wimboot-bios

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS build
ARG TARGETARCH
WORKDIR /src
RUN --mount=type=bind,from=prepare,source=/source.tar.gz,target=/tmp/source.tar.gz --network=none tar -xzf /tmp/source.tar.gz
RUN go mod download
RUN --network=none CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath -buildvcs=false \
    -ldflags="-s -w -buildid= -X bootimus/internal/server.Version=0.1.81-pl.x86.1" -o /out/bootimus .
COPY apps/f12/pxe/*.go /src/pl-pxe/
RUN --network=none CGO_ENABLED=0 go test -mod=readonly ./pl-pxe && \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=readonly -trimpath -buildvcs=false \
    -ldflags="-s -w -buildid=" -o /out/pxe-worker ./pl-pxe
RUN --network=none install -D -m 0444 bootloaders/default/undionly.kpxe /out/firmware/undionly.kpxe && \
    install -D -m 0444 bootloaders/secureboot-official-snp/ipxe-shimx64.efi /out/firmware/x86_64-sb/snponly-shim.efi && \
    install -D -m 0444 bootloaders/secureboot-official-snp/ipxe.efi /out/firmware/x86_64-sb/snponly.efi

FROM docker.io/garybowers/bootimus:0.1.81@sha256:dae7b9a4eaf796a3586aabed71cdf7bfddd6058f8b43d54992e836aa9836bdc8 AS userspace
RUN --network=none --mount=type=bind,from=prepare,source=/inputs/packages,target=/tmp/pl-debs \
    apt-get -y --no-install-recommends install /tmp/pl-debs/*.deb && \
    rm /bootimus && ln -s /usr/bin/python3 /usr/local/bin/python3 && install -d -m 0700 -o 65532 -g 65532 /data && \
    command -v bsdtar && command -v wiminfo && command -v xorriso && \
    python3 -c 'import hashlib, http.server, shutil, socket, sqlite3, ssl, subprocess, sys, threading; assert sys.version_info >= (3, 11)'

# Copy the merged userspace. The upstream executable and its embedded firmware
# must also be absent from the layers delivered to the customer.
FROM scratch AS server
ARG TARGETARCH
COPY --from=userspace / /
COPY --from=prepare /python/pycdlib/ /usr/lib/python3/dist-packages/pycdlib/
COPY --from=prepare /python/pycdlib-1.22.0.dist-info/ /usr/lib/python3/dist-packages/pycdlib-1.22.0.dist-info/
COPY --from=build /out/bootimus /opt/pl-f12/bootimus
COPY --from=build /out/pxe-worker /opt/pl-f12/pxe-worker
COPY --from=build /out/firmware/ /opt/pl-f12/firmware/
COPY apps/f12/native.py apps/f12/bootimus.py apps/f12/media.py apps/f12/library.py apps/f12/uploads.py apps/f12/gateway.py apps/f12/winpe_profile.py apps/f12/strelec_media.py apps/f12/pxe_control.py /opt/pl-f12/
COPY --from=windows-guest /out/ /opt/pl-f12/strelec/
COPY --from=strelec-bios-amd64 /out/wimboot-bios /opt/pl-f12/strelec/wimboot-bios
COPY apps/f12/winpe/winpeshl.ini apps/f12/winpe/pl-f12.cmd apps/f12/winpe/F12Media.cs /opt/pl-f12/winpe/
COPY --from=prepare --chmod=0444 /inputs/wimboot-2.9.0 /opt/pl-f12/winpe/wimboot
COPY deploy/images/f12.sources.json deploy/images/f12.LICENSE deploy/images/f12-runtime.json deploy/images/f12-source-lock.json deploy/images/f12-sources.py deploy/images/f12-wimboot-e587564.tar.gz deploy/images/f12-wimboot-sstr.patch /usr/share/pl/provenance/f12/
COPY --from=windows-toolchain /usr/share/doc/mingw-w64-common/copyright /usr/share/pl/provenance/f12/mingw-w64.COPYRIGHT
COPY --from=windows-toolchain /usr/share/doc/gcc-mingw-w64-base/copyright /usr/share/pl/provenance/f12/gcc-mingw-w64.COPYRIGHT
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN --network=none python3 -c 'import hashlib, json, sys; ref=json.load(open("/usr/share/pl/provenance/f12/f12.sources.json")); actual=hashlib.file_digest(open("/opt/pl-f12/bootimus","rb"),"sha256").hexdigest(); assert actual == ref["upstream"]["bootimus_binary_sha256"][sys.argv[1]]' "$TARGETARCH"
LABEL org.opencontainers.image.version="0.1.81" pl.upstream.version="0.1.81" pl.module.id="f12" pl.f12.pxe.version="1" \
    pl.module.role="server" pl.module.config.version="1" pl.build.variant="upstream-pinned"
WORKDIR /data
USER 65532:65532
RUN --network=none python3 -B - <<'PY'
import hashlib
import json
from pathlib import Path

provenance = Path("/usr/share/pl/provenance/f12")
bios = json.loads((provenance / "f12.sources.json").read_bytes())["upstream"]["wimboot_bios"]
sources = json.loads((provenance / "f12-source-lock.json").read_bytes())["files"]
archive = (provenance / bios["packaged_source"]).read_bytes()
assert hashlib.sha256(archive).hexdigest() == sources[bios["archive"]]["sha256"]
loader = Path("/opt/pl-f12/strelec/wimboot-bios").read_bytes()
assert hashlib.sha256(loader).hexdigest() == bios["sha256"]
assert (provenance / bios["patch"]).read_bytes() and (provenance / "f12.LICENSE").read_bytes()
PY
RUN --network=none test -x /opt/pl-f12/pxe-worker && test -r /opt/pl-f12/firmware/undionly.kpxe && \
    test -r /opt/pl-f12/firmware/x86_64-sb/snponly-shim.efi && test -r /opt/pl-f12/firmware/x86_64-sb/snponly.efi
RUN --network=none python3 -B -c 'from importlib.metadata import version; import hivex, os; from pycdlib import PyCdlib; assert version("pycdlib") == "1.22.0" and os.path.samefile("/usr/bin/python3","/usr/local/bin/python3"); PyCdlib()'
RUN --network=none test -r /opt/pl-f12/strelec/winpeshl.ini && test -r /opt/pl-f12/strelec/pl-strelec-x86.exe && test -r /opt/pl-f12/strelec/pl-strelec-x64.exe
ENTRYPOINT ["python3", "-B", "-u", "/opt/pl-f12/native.py"]
CMD ["serve"]
