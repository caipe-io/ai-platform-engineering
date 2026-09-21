# ---------- Stage 1: Build dependencies into a venv ----------
FROM python:3.14-slim AS builder

RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
        gcc \
    && pip install --no-cache-dir uv==0.12.6 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the full project so hatchling can build the local package (uv sync needs sources).
COPY --chown=root:root . /app/

# Reproducible install from the committed lockfile, no dev deps.
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_HTTP_TIMEOUT=900 uv sync --locked --no-dev

# ---------- Stage 2: Final runtime image ----------
# Wolfi (Chainguard) base: 0 CVEs, continuously patched packages.
FROM cgr.dev/chainguard/wolfi-base

# Override APK repo to public Wolfi OS packages (no auth required).
RUN echo "https://packages.wolfi.dev/os" > /etc/apk/repositories

# Install runtime: python 3.14 + shadow (groupadd/useradd).
RUN for i in 1 2 3; do \
        apk add --no-cache python-3.14 shadow && break; \
        [ $i -lt 3 ] && sleep $((i * 5)); \
    done && \
    apk upgrade --no-cache

# Wolfi puts Python at /usr/bin/python3.14; keep venv symlinks consistent.
RUN mkdir -p /usr/local/bin \
    && ln -sf /usr/bin/python3.14 /usr/local/bin/python3.14 \
    && ln -sf /usr/bin/python3.14 /usr/local/bin/python3 \
    && ln -sf /usr/bin/python3.14 /usr/local/bin/python

# Non-root runtime user (UID/GID 1001).
RUN groupadd -r -g 1001 appuser && useradd -r -g appuser -u 1001 -M -s /sbin/nologin appuser

WORKDIR /app

ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Pull venv + sources from the builder image.
COPY --from=builder --chown=appuser:appuser /app /app

USER 1001:1001

EXPOSE 9100

CMD ["python", "main.py"]
