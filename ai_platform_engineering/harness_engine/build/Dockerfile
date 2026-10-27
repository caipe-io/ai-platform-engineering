FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS builder

WORKDIR /app
COPY ai_platform_engineering/harness_engine/pyproject.toml ai_platform_engineering/harness_engine/uv.lock ./
RUN uv sync --frozen --no-dev

COPY ai_platform_engineering/harness_engine/src ./src

FROM python:3.13-slim-bookworm
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONPATH="/app/src" \
    HARNESS_ENGINE_HOST="0.0.0.0" \
    HARNESS_ENGINE_PORT="8010"
USER 65532:65532
EXPOSE 8010
CMD ["python", "-m", "harness_engine.main"]
