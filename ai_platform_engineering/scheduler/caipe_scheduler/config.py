"""Configuration loaded from environment variables."""

from __future__ import annotations

import os

from pydantic import BaseModel, Field


class Settings(BaseModel):
  # Mongo
  mongodb_uri: str = Field(
    default_factory=lambda: os.environ.get(
      "MONGODB_URI",
      "mongodb://admin:changeme@caipe-mongodb:27017/caipe?authSource=admin",
    )
  )
  mongodb_database: str = Field(default_factory=lambda: os.environ.get("MONGODB_DATABASE", "caipe"))
  schedules_collection: str = Field(default_factory=lambda: os.environ.get("SCHEDULES_COLLECTION", "schedules"))
  one_off_runs_collection: str = Field(default_factory=lambda: os.environ.get("ONE_OFF_RUNS_COLLECTION", "schedule_one_off_runs"))

  # Auth: shared service token between dynamic-agents and scheduler-svc.
  # Sent as `X-Scheduler-Token` header on every request.
  service_token: str = Field(default_factory=lambda: os.environ.get("SCHEDULER_SERVICE_TOKEN", ""))
  service_token_secret_name: str = Field(
    default_factory=lambda: os.environ.get(
      "SCHEDULER_SERVICE_TOKEN_SECRET_NAME",
      "caipe-scheduler-service-token",
    )
  )
  service_token_secret_key: str = Field(
    default_factory=lambda: os.environ.get(
      "SCHEDULER_SERVICE_TOKEN_SECRET_KEY",
      "token",
    )
  )

  # Caller JWT validation for user-owned schedule operations.
  jwt_jwks_url: str = Field(default_factory=lambda: os.environ.get("SCHEDULER_JWT_JWKS_URL", ""))
  jwt_issuer: str = Field(default_factory=lambda: os.environ.get("SCHEDULER_JWT_ISSUER", ""))
  jwt_audiences: tuple[str, ...] = Field(default_factory=lambda: tuple(value.strip() for value in os.environ.get("SCHEDULER_JWT_AUDIENCES", "caipe-platform").split(",") if value.strip()))
  jwt_algorithms: tuple[str, ...] = Field(default_factory=lambda: tuple(value.strip() for value in os.environ.get("SCHEDULER_JWT_ALGORITHMS", "RS256").split(",") if value.strip()))

  # Kubernetes
  namespace: str = Field(default_factory=lambda: os.environ.get("SCHEDULER_NAMESPACE", "caipe"))
  cron_runner_image: str = Field(default_factory=lambda: os.environ.get("CRON_RUNNER_IMAGE", "ghcr.io/caipe-io/caipe-cron-runner:latest"))
  cron_runner_image_pull_policy: str = Field(default_factory=lambda: os.environ.get("CRON_RUNNER_IMAGE_PULL_POLICY", "IfNotPresent"))
  # ServiceAccount for the per-schedule CronJob runner pods. No perms.
  cron_runner_service_account: str = Field(default_factory=lambda: os.environ.get("CRON_RUNNER_SERVICE_ACCOUNT", "caipe-cron-runner"))
  # Internal URL the runner uses to call back into scheduler-svc.
  scheduler_internal_url: str = Field(default_factory=lambda: os.environ.get("SCHEDULER_INTERNAL_URL", "http://caipe-scheduler:8080"))
  # Where the runner POSTs the chat message.
  caipe_api_url: str = Field(default_factory=lambda: os.environ.get("CAIPE_API_URL", "http://caipe-ui:3000"))
  caipe_chat_path: str = Field(default_factory=lambda: os.environ.get("CAIPE_CHAT_PATH", "/api/v1/chat/invoke"))

  # Limits
  max_schedules_per_owner: int = Field(default_factory=lambda: int(os.environ.get("MAX_SCHEDULES_PER_OWNER", "50")))
  max_message_chars: int = Field(default_factory=lambda: int(os.environ.get("MAX_MESSAGE_CHARS", "2000")))
  minimum_schedule_interval_seconds: int = Field(
    default_factory=lambda: int(os.environ.get("MINIMUM_SCHEDULE_INTERVAL_SECONDS", "1800")),
    ge=1,
    validate_default=True,
  )

  # One-off run dispatcher. One-off records are stored in Mongo with UTC run_at;
  # the scheduler pod wakes near the next due record and creates a normal Job.
  one_off_dispatch_enabled: bool = Field(default_factory=lambda: os.environ.get("ONE_OFF_DISPATCH_ENABLED", "true").lower() not in {"0", "false", "no"})
  one_off_dispatch_interval_seconds: int = Field(default_factory=lambda: int(os.environ.get("ONE_OFF_DISPATCH_INTERVAL_SECONDS", "30")))
  one_off_dispatch_batch_size: int = Field(default_factory=lambda: int(os.environ.get("ONE_OFF_DISPATCH_BATCH_SIZE", "50")))
  one_off_dispatch_concurrency: int = Field(default_factory=lambda: int(os.environ.get("ONE_OFF_DISPATCH_CONCURRENCY", "5")))
  one_off_claim_timeout_seconds: int = Field(default_factory=lambda: int(os.environ.get("ONE_OFF_CLAIM_TIMEOUT_SECONDS", "300")))


_settings: Settings | None = None


def get_settings() -> Settings:
  global _settings
  if _settings is None:
    _settings = Settings()
  return _settings
