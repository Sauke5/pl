FROM prom/blackbox-exporter:v0.28.0 AS blackbox

FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN addgroup --system --gid 10001 websites-admin \
    && adduser --system --uid 10001 --ingroup websites-admin --home /app websites-admin

COPY --from=blackbox /bin/blackbox_exporter /usr/local/bin/blackbox_exporter
COPY pyproject.toml /app/pyproject.toml
RUN pip install --no-cache-dir ".[test]"

COPY alembic.ini /app/alembic.ini
COPY migrations /app/migrations
COPY app /app/app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/blackbox_exporter \
    && chown -R websites-admin:websites-admin /app

USER websites-admin

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips=*"]
