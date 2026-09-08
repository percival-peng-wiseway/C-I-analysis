# syntax=docker/dockerfile:1

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    CI_PADDLE_MODEL_DIR=/opt/e3-paddle-models \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        libharfbuzz-subset0 \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        shared-mime-info \
        libgomp1 \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY api ./api
# Keep the source-directory spelling explicit. Besides being clearer, changing
# this instruction invalidates any stale remote-builder layer left by an older
# deployment so the next image must recopy the authoritative Python package.
COPY ./solar_battery/ ./solar_battery/
COPY alembic_ci ./alembic_ci
COPY alembic-ci.ini ./
COPY scripts/start_cloudflare_container.sh /usr/local/bin/start-e3-ci

RUN sed -i 's/\r$//' /usr/local/bin/start-e3-ci \
    && pip install --no-cache-dir ".[api,pdf,postgres,ocr]" \
    && PADDLE_PDX_MODEL_SOURCE=BOS python -m solar_battery.ci_paddle_ocr --download /opt/e3-paddle-models \
    && chmod -R a+rX /opt/e3-paddle-models \
    && chmod 0555 /usr/local/bin/start-e3-ci \
    && useradd --create-home --uid 10001 e3ci \
    && chown -R e3ci:e3ci /app

USER e3ci
EXPOSE 8080

CMD ["/usr/local/bin/start-e3-ci"]
