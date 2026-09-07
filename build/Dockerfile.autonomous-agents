# syntax=docker/dockerfile:1.7
#
# Autonomous Agents service image.
#
# Hardening notes (IMP-04):
# * Two-stage build -- ``uv`` and any build-time tooling stay in the
#   builder stage; the final runtime image is just ``python:3.13-slim-bookworm``
#   plus the resolved venv and our source.
# * Final stage runs as the non-root ``app`` user (UID/GID 1001) -- the
#   project-wide container rule rejects root.
# * Source code, config, and ``pyproject.toml``/``uv.lock`` are copied
#   from the builder as root-owned. Only ``/app/.venv`` is chowned to
#   ``app:app`` so the runtime can't tamper with its own code even if
#   the container is launched without ``--read-only`` (Copilot review
#   on PR #8).
# * Both base images are pinned to specific Debian variants
#   (``bookworm``) for reproducible builds and a stable CVE baseline.
# * Recommended runtime flags (see README "Run with Docker"):
#       --user app:app          # already the default, kept for clarity
#       --read-only
#       --tmpfs /tmp
#       --security-opt=no-new-privileges
#       --cap-drop=ALL
#       --pids-limit=256
#       --memory=512m --cpus=1

# =============================================================================
# Stage 1: builder -- runs as root, has uv, never reaches production
# =============================================================================
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_HTTP_TIMEOUT=300 \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# Install dependencies first for better layer caching: only the lock
# file changes invalidate this layer, not source edits.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    uv sync --locked --no-install-project --no-dev

# Now bring in the source and finalise the install.
COPY pyproject.toml uv.lock ./
COPY src/ src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev

# Trim the venv to keep the production layer lean.
RUN find /app/.venv -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true && \
    find /app/.venv -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true && \
    find /app/.venv -name "*.pyc" -delete 2>/dev/null || true

# =============================================================================
# Stage 2: runtime -- pinned slim, no uv, no apt, runs as ``app``
# =============================================================================
FROM python:3.13-slim-bookworm

# Create the unprivileged runtime user. ``--no-create-home`` because we
# never need a writable HOME -- if the app does, mount a tmpfs at /home/app.
ARG APP_UID=1001
ARG APP_GID=1001
RUN groupadd --system --gid "${APP_GID}" app \
 && useradd  --system --uid "${APP_UID}" --gid app \
             --home-dir /app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

# Source and pyproject metadata stay root-owned with default
# 644 perms. ``app`` can read them (world-readable) but can't modify
# them, even when the container is run without ``--read-only``.
COPY --from=builder /app/pyproject.toml /app/uv.lock ./
COPY --from=builder /app/src/ ./src/

# Only the venv is owned by ``app`` -- it's the one tree the runtime
# is expected to read+execute from. (Even then it's not modified
# during normal operation.)
COPY --from=builder --chown=app:app /app/.venv /app/.venv

ENV PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

EXPOSE 8002

# Drop to the unprivileged user for the actual process. Anything that
# needs root must happen in the builder stage above.
USER app:app

# uvicorn is the venv-installed entrypoint (see PATH above).
CMD ["uvicorn", "autonomous_agents.main:app", "--host", "0.0.0.0", "--port", "8002"]
