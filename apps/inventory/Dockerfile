FROM python:3.15.0-slim-trixie@sha256:2da676046630d7bf14c6764ae1143dc7fa0377a53f94bf5a642f0b214aca5bce
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
LABEL org.pl.project="inventory"
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home inventory
COPY inventory_service ./inventory_service
COPY web ./web
USER 10001:10001
EXPOSE 8587
CMD ["python", "-m", "uvicorn", "inventory_service.app:app", "--host", "0.0.0.0", "--port", "8587", "--workers", "1", "--no-access-log"]
