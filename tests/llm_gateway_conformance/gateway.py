"""Gateway profile and request helpers shared by the conformance checks."""

import os
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

PREFIX = "LLM_GW_CONFORMANCE_"


def env(name: str, default: str = "") -> str:
    return os.environ.get(PREFIX + name, default).strip()


@dataclass(frozen=True)
class GatewayProfile:
    base_url: str
    auth: str
    model: str
    key: str
    revoked_key: str
    agent_limit_key: str
    team_limit_key: str
    error_models: dict[int, str] = field(default_factory=dict)
    limit_store_down: bool = False
    limit_store_grace_seconds: float = 0.0
    limit_store_down_at: float = 0.0
    limit_statuses: frozenset[int] = frozenset({402, 422, 429})
    limit_error_type: str = ""

    @classmethod
    def from_env(cls) -> "GatewayProfile":
        errors: dict[int, str] = {}
        for item in filter(None, env("ERROR_MODELS").split(",")):
            status, _, model = item.partition("=")
            errors[int(status)] = model.strip()
        return cls(
            base_url=env("BASE_URL").rstrip("/"),
            auth=env("AUTH", "key"),
            model=env("MODEL", "mock-chat"),
            key=env("KEY"),
            revoked_key=env("REVOKED_KEY"),
            agent_limit_key=env("AGENT_LIMIT_KEY"),
            team_limit_key=env("TEAM_LIMIT_KEY"),
            error_models=errors,
            limit_store_down=env("LIMIT_STORE_DOWN") == "1",
            limit_store_grace_seconds=float(env("LIMIT_STORE_GRACE_SECONDS", "0")),
            limit_store_down_at=float(env("LIMIT_STORE_DOWN_AT", "0")),
            limit_error_type=env("LIMIT_ERROR_TYPE"),
            limit_statuses=frozenset(int(s) for s in env("LIMIT_STATUSES", "402,422,429").split(",")),
        )


def require(value: Any, what: str) -> Any:
    if not value:
        pytest.skip(f"NOT_RUN: {what} not configured")
    return value


def chat(client: httpx.Client, key: str | None, model: str, **extra: Any) -> httpx.Response:
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    body = {"model": model, "messages": [{"role": "user", "content": "Reply with one word."}], **extra}
    return client.post("/v1/chat/completions", headers=headers, json=body)
