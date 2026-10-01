# Dynamic Agents Service Dockerfile
# Two-stage build for secure, minimal production image

# =============================================================================
# Stage 1: Builder - Install dependencies with uv
# =============================================================================
FROM ghcr.io/astral-sh/uv:0.12.6-python3.14-trixie-slim AS builder

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# Use system Python (same version as final image)
ENV UV_PYTHON_DOWNLOADS=0

WORKDIR /app/dynamic_agents

# Install dependencies first (cached layer)
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    UV_HTTP_TIMEOUT=900 uv sync --locked --no-install-project --no-dev

# Copy source code and install project
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_HTTP_TIMEOUT=900 uv sync --locked --no-dev

# Patch langchain_aws ChatBedrock._as_converse to forward base_model_id to
# ChatBedrockConverse. Without this, switching to the Converse API (e.g. when
# beta_use_converse_api=True) creates a new ChatBedrockConverse without base_model_id,
# triggering a GetInferenceProfile API call that fails when the IAM role only
# grants bedrock:InvokeModel / bedrock-runtime:Converse on the AIP ARN.
# Remove this patch once langchain-aws fixes _as_converse to forward base_model_id.
RUN BEDROCK_PY=".venv/lib/python3.14/site-packages/langchain_aws/chat_models/bedrock.py" && \
    grep -q 'guardrail_config=(self.guardrails if self._guardrails_enabled else None),  # type: ignore\[call-arg\]' "$BEDROCK_PY" || \
        { echo "ERROR: langchain_aws patch target not found — upstream may have changed. Review dynamic_agents/build/Dockerfile patch."; exit 1; } && \
    sed -i 's/guardrail_config=(self.guardrails if self._guardrails_enabled else None),  # type: ignore\[call-arg\]/guardrail_config=(self.guardrails if self._guardrails_enabled else None),  # type: ignore[call-arg]\n            base_model_id=self.base_model_id,/' "$BEDROCK_PY" && \
    grep -q 'base_model_id=self.base_model_id,' "$BEDROCK_PY" || \
        { echo "ERROR: langchain_aws patch was not applied — sed substitution had no effect."; exit 1; }

# Cleanup to reduce image size (~50-100MB savings)
RUN find /app/dynamic_agents/.venv -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true && \
    find /app/dynamic_agents/.venv -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true && \
    find /app/dynamic_agents/.venv -type d -name "test" -exec rm -rf {} + 2>/dev/null || true && \
    find /app/dynamic_agents/.venv -name "*.pyc" -delete 2>/dev/null || true && \
    find /app/dynamic_agents/.venv -name "*.pyi" -delete 2>/dev/null || true && \
    find /app/dynamic_agents/.venv -type d -name "include" -path "*/site-packages/*" -exec rm -rf {} + 2>/dev/null || true

# =============================================================================
# Stage 2: Runtime - Minimal secure image
# =============================================================================
# Wolfi provides a minimal, continuously patched glibc runtime while preserving
# compatibility with the manylinux wheels installed by the builder stage.
FROM cgr.dev/chainguard/wolfi-base

# Override APK repo to public Wolfi OS packages (no auth required).
# cgr.dev/chainguard/wolfi-base defaults to apk.cgr.dev/chainguard which
# requires Chainguard credentials; packages.wolfi.dev/os is free and public.
RUN echo "https://packages.wolfi.dev/os" > /etc/apk/repositories

# glibc-based Python 3.14 (matches the builder ABI so manylinux wheels load
# correctly). `curl` is kept for the curl builtin tool; `ca-certificates-bundle`
# ensures outbound TLS (Bedrock/LLM) works; `shadow` provides useradd/groupadd.
# Retry to tolerate transient mirror blips.
RUN for i in 1 2 3; do \
        apk add --no-cache python-3.14 ca-certificates-bundle curl shadow && break; \
        [ $i -lt 3 ] && sleep $((i * 10)); \
    done && \
    apk upgrade --no-cache

# The builder stage places Python at
# /usr/local/bin/python3.14; Wolfi places it at /usr/bin/python3.14. These
# symlinks keep the venv's internal python symlinks valid in the final image.
RUN mkdir -p /usr/local/bin \
    && ln -sf /usr/bin/python3.14 /usr/local/bin/python3.14 \
    && ln -sf /usr/bin/python3.14 /usr/local/bin/python3 \
    && ln -sf /usr/bin/python3.14 /usr/local/bin/python

# Create non-root user (UID/GID 1001 for Kubernetes compatibility)
RUN groupadd -g 1001 app && useradd -u 1001 -g app -m app

# Copy application from builder
COPY --from=builder --chown=app:app /app /app

WORKDIR /app/dynamic_agents

# Add virtual environment to PATH
ENV PATH="/app/dynamic_agents/.venv/bin:$PATH"

# Run as non-root user
USER app

# Default port (configurable via PORT env var)
EXPOSE 8001

# Health check
# Use /healthz (the actual FastAPI route in routes/health.py) and parse the JSON body —
# the route returns 200 with {"status": "unhealthy"} when MongoDB is down, so checking
# only the HTTP status would mask real failures.
# Note: in Kubernetes the Helm chart's livenessProbe/readinessProbe override this directive;
# this primarily covers `docker run` and standalone use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import json,urllib.request,sys; r=urllib.request.urlopen('http://localhost:8001/healthz',timeout=3); sys.exit(0 if r.status==200 and json.load(r).get('status')=='healthy' else 1)" || exit 1

# Run the application
CMD ["python3", "src/dynamic_agents/main.py"]
