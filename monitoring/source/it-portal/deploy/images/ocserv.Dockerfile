# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
FROM docker.io/library/debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b AS snapshot
RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261115T000000Z sid main' > /etc/apt/sources.list

FROM scratch AS upstream
ADD --checksum=sha256:2d3303a0d9e06eabfa08694b9dca3c558fef36418857bebf1b8de57ece5f9f32 https://snapshot.debian.org/archive/debian/20261115T000000Z/pool/main/o/ocserv/ocserv_1.6.0.orig.tar.xz /
ADD --checksum=sha256:9d193c90df4eb029be71ff947dfce9d80a813a11c2d542112ab5fa20828119c1 https://snapshot.debian.org/archive/debian/20261115T000000Z/pool/main/o/ocserv/ocserv_1.6.0-3.debian.tar.xz /

FROM snapshot AS build-deps
RUN sed 's/^deb /deb-src /' /etc/apt/sources.list > /etc/apt/sources.list.d/ocserv-source.list && \
    apt-get -o Acquire::Retries=3 update && \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -y --no-install-recommends \
      build-dep ocserv=1.6.0-3 && rm -rf /var/lib/apt/lists/*

FROM build-deps AS build
RUN apt-get -o Acquire::Retries=3 update && \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -y --no-install-recommends install fakeroot netcat-openbsd xxd && \
    rm -rf /var/lib/apt/lists/* && useradd --create-home --user-group builder && \
    install -d -o builder -g builder /build /build/ocserv /out
WORKDIR /build/ocserv
COPY --from=upstream --chown=builder:builder / /build/
USER builder
RUN tar -xJf ../ocserv_1.6.0.orig.tar.xz --strip-components=1 && tar -xJf ../ocserv_1.6.0-3.debian.tar.xz
COPY --chown=builder:builder deploy/images/ocserv-dex-id-token.patch deploy/images/ocserv-test-syslog-fortify.patch debian/patches/
RUN <<'BUILD'
set -eu
printf '%s\n' ocserv-dex-id-token.patch ocserv-test-syslog-fortify.patch >> debian/patches/series
{
    printf '%s\n' 'ocserv (1.6.0-3+pl1) unstable; urgency=medium' '' \
        '  * Accept an optional JOSE typ in browser-flow ID tokens.' \
        '  * Capture fortified glibc syslog calls in the test shim.' '' \
        ' -- PL <packaging@localhost>  Wed, 18 Nov 2026 00:00:00 +0000' ''
    cat debian/changelog
} > debian/changelog.pl
mv debian/changelog.pl debian/changelog
# Debian tolerates smoke failures and enforces them separately in autopkgtest.
# The PL image build requires the in-build suite to pass.
sed -i 's/^\([[:space:]]\)-dh_auto_test$/\1dh_auto_test/' debian/rules
grep -qx "$(printf '\tdh_auto_test')" debian/rules

# Upstream's verbose output contains transient test cookies. Report only test
# names, counts, and build stages, and keep the raw log inside this RUN.
log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0
LC_ALL=C.UTF-8 DEB_BUILD_OPTIONS=noautodbgsym dpkg-buildpackage -B -us -uc -j4 > "$log" 2>&1 || status=$?
awk -v status="$status" '
    /^[[:space:]]*dh_[a-z_]+([[:space:]]|$)/ { stage=$1 }
    $1 ~ /^[0-9]+\/[0-9]+$/ && $2 ~ /^ocserv:[a-zA-Z0-9_.-]+$/ && $3 ~ /^(FAIL|SKIP|TIMEOUT)$/ {
        if (!seen[$2,$3]++) print $2, $3
    }
    /^(Ok|Fail|Skipped|Timeout|Expected Fail|Unexpected Pass):[[:space:]]+[0-9]+[[:space:]]*$/ {
        if (!seen[$0]++) print
    }
    /^[a-zA-Z0-9_.\/-]+:[0-9]+:[0-9]+: (fatal )?error:/ { print "Compiler error at", $1 }
    END { if (status != 0) print "dpkg-buildpackage exited", status, "during", stage }
' "$log"
[ "$status" -eq 0 ] || exit "$status"
grep -Eq '^Ok:[[:space:]]+[1-9][0-9]*[[:space:]]*$' "$log"
install -Dm644 ../ocserv_1.6.0-3+pl1_*.deb /out/ocserv.deb
cd /
rm -rf /build/ocserv
BUILD

FROM snapshot AS runtime
RUN --mount=type=bind,from=build,source=/out,target=/packages \
    apt-get -o Acquire::Retries=3 update && \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -y --no-install-recommends install \
      /packages/ocserv.deb python3 nftables iproute2 ca-certificates && \
    rm -rf /var/lib/apt/lists/* /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem && \
    test "$(dpkg-query -W -f='${Version}' ocserv)" = '1.6.0-3+pl1' && ocserv --version && occtl --version && nft --version

FROM runtime AS server
LABEL org.opencontainers.image.version="1.6.0" pl.upstream.version="1.6.0" \
      pl.module.id="ocserv" pl.module.role="server" pl.module.config.version="1" pl.build.variant="upstream-pinned"
# libcurl in ocserv uses the distribution's configured CA file. The worker
# supervisor populates its target when Docker mounts a fresh tmpfs on /run.
RUN mkdir -p /usr/share/pl-ocserv /run/pl-ocserv-trust && \
    mv /etc/ssl/certs/ca-certificates.crt /usr/share/pl-ocserv/debian-ca.crt && \
    ln -s /usr/share/pl-ocserv/debian-ca.crt /run/pl-ocserv-trust/ca-certificates.crt && \
    ln -s /run/pl-ocserv-trust/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY apps/ocserv/gateway.py apps/ocserv/policy.py apps/ocserv/runtime.py /opt/pl-ocserv/
COPY --chmod=0755 apps/ocserv/pl-ocserv /usr/local/bin/pl-ocserv
COPY --from=upstream / /usr/share/pl/provenance/ocserv/
COPY deploy/images/ocserv.sources.json deploy/images/ocserv.LICENSE deploy/images/ocserv-dex-id-token.patch deploy/images/ocserv-test-syslog-fortify.patch /usr/share/pl/provenance/ocserv/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=UTC
EXPOSE 4443/tcp 4443/udp
ENTRYPOINT ["/usr/local/bin/pl-ocserv"]
CMD ["serve"]
