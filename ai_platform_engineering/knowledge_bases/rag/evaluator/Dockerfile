# Multi-stage Dockerfile for caipe-deepeval-evaluation
# Compatible with Docker, Podman, K3s / Kubernetes (OCI compliant)

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS builder

WORKDIR /app

# Enable bytecode compilation for performance
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy

# Copy dependency specifications first to leverage build cache
COPY pyproject.toml uv.lock README.md /app/

# Install dependencies without installing the project root yet
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# Copy application source code
COPY src /app/src

# Sync project
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# Final runtime image
FROM python:3.13-slim AS runner

WORKDIR /app

# Ensure logs are sent straight to stdout/stderr without buffering
ENV PYTHONUNBUFFERED=1
ENV PATH="/app/.venv/bin:$PATH"

# Create a non-root system user for security in K3s / K8s clusters
RUN groupadd -g 1000 appgroup && \
    useradd -u 1000 -g appgroup -s /bin/sh -m appuser && \
    mkdir -p /app/data /app/cache /app/results && \
    chown -R appuser:appgroup /app

# Copy virtual environment and application code from builder stage
COPY --from=builder --chown=appuser:appgroup /app/.venv /app/.venv
COPY --from=builder --chown=appuser:appgroup /app/src /app/src
COPY --from=builder --chown=appuser:appgroup /app/pyproject.toml /app/pyproject.toml

# Switch to non-root user
USER appuser

EXPOSE 8000

# Default entrypoint starts the FastAPI evaluator server
CMD ["uvicorn", "deepeval_eval.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
