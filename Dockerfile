# syntax=docker/dockerfile:1

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        libharfbuzz-subset0 \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        shared-mime-info \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY api ./api
COPY solar_battery ./solar_battery
COPY alembic_ci ./alembic_ci
COPY alembic-ci.ini ./
COPY scripts/start_cloudflare_container.sh /usr/local/bin/start-e3-ci

RUN pip install --no-cache-dir ".[api,pdf,postgres]" \
    && chmod 0555 /usr/local/bin/start-e3-ci \
    && useradd --create-home --uid 10001 e3ci \
    && chown -R e3ci:e3ci /app

USER e3ci
EXPOSE 8080

CMD ["/usr/local/bin/start-e3-ci"]
