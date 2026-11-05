# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Community container linked by BookStack's installation documentation.
# Preserve native BookStack assets, authentication, sessions and migrations.
FROM ghcr.io/linuxserver/bookstack:v26.09.2-ls293@sha256:2fdeeb1a2028ce7cb1274696237e32b9f849e16b6d77314d08c78356a6016fca AS web
LABEL org.opencontainers.image.version="26.09.2" \
      pl.upstream.version="26.09.2" \
      pl.module.id="bookstack" \
      pl.module.role="web" \
      pl.module.config.version="1" \
      pl.build.variant="upstream-pinned"
COPY apps/wiki/bootstrap-admin.php /usr/local/share/pl/bookstack/bootstrap-admin.php
COPY deploy/images/bookstack.sources.json /usr/local/share/pl/bookstack/sources.json
# BookStack's dropzone uses decimal MB; PHP's 100M uses binary MiB.
# Match the browser threshold to the exact PHP limit: 100 * 1024 * 1024 bytes.
ENV FILE_UPLOAD_SIZE_LIMIT=104.8576 \
    PHP_INI_SCAN_DIR="${PHP_INI_SCAN_DIR}:/usr/local/share/pl/bookstack/php-conf.d"
# Preserve every native scan directory, then apply Pl's multipart envelope after
# the persistent /config/php/php-local.ini without rewriting the user's file.
# s6 starts web services after init-bookstack-config. Initial credentials are replaced
# before serving requests, and remain in private mounted files, never CLI arguments.
RUN mkdir -p /usr/local/share/pl/bookstack/php-conf.d && \
    chmod 0755 /usr/local/share/pl/bookstack/php-conf.d && \
    test -f /etc/s6-overlay/s6-rc.d/init-bookstack-config/run && \
    cat >> /etc/s6-overlay/s6-rc.d/init-bookstack-config/run <<'SH'

printf 'upload_max_filesize=100M\npost_max_size=101M\n' > /usr/local/share/pl/bookstack/php-conf.d/zz-pl-uploads.ini || exit 1
chmod 0644 /usr/local/share/pl/bookstack/php-conf.d/zz-pl-uploads.ini || exit 1
php -r '
$files = array_map("trim", explode(",", (string) php_ini_scanned_files()));
$local = array_search("/config/php/php-local.ini", $files, true);
$policy = array_search("/usr/local/share/pl/bookstack/php-conf.d/zz-pl-uploads.ini", $files, true);
if ($local === false || $policy === false || $policy <= $local || $policy !== count($files) - 1 || ini_get("upload_max_filesize") !== "100M" || ini_get("post_max_size") !== "101M") {
    fwrite(STDERR, "BookStack upload limits or ini load order are invalid\n");
    exit(1);
}
' || exit 1
php /usr/local/share/pl/bookstack/bootstrap-admin.php || exit 1
SH

FROM mariadb:13.0.2@sha256:f4054da26e3a9dd6c8b5cc97363e544408b15c0fb369d7359c25dc04826eb6e1 AS database
LABEL org.opencontainers.image.version="26.09.2" \
      pl.upstream.version="13.0.2" \
      pl.module.id="bookstack" \
      pl.module.role="database" \
      pl.module.config.version="1" \
      pl.build.variant="upstream-pinned"
COPY deploy/images/bookstack.sources.json /usr/local/share/pl/bookstack/sources.json
