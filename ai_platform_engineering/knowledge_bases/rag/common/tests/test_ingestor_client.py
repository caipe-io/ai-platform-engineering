"""Focused tests for the shared authenticated RAG ingestor client."""

import asyncio
from unittest.mock import AsyncMock

import pytest

from common.ingestor import Client


def test_discovery_url_only_failure_reports_the_attempt(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  """A transient discovery failure must not become UnboundLocalError."""
  monkeypatch.delenv("INGESTOR_OIDC_ISSUER", raising=False)
  monkeypatch.setenv(
    "INGESTOR_OIDC_DISCOVERY_URL",
    "https://identity.example.test/.well-known/openid-configuration",
  )
  monkeypatch.setenv("INGESTOR_OIDC_CLIENT_ID", "example-ingestor")
  monkeypatch.setenv("INGESTOR_OIDC_CLIENT_SECRET", "example-secret")

  client = Client("primary", "webloader")
  client._fetch_discovery = AsyncMock(side_effect=OSError("identity service unavailable"))

  with pytest.raises(RuntimeError, match="Discovery URL.*identity service unavailable"):
    asyncio.run(client._discover_token_endpoint())


def test_unreachable_issuer_fallback_is_not_cached(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  """A startup race must retry discovery instead of pinning localhost."""
  monkeypatch.setenv(
    "INGESTOR_OIDC_DISCOVERY_URL",
    "http://identity.example.test/.well-known/openid-configuration",
  )
  monkeypatch.setenv("INGESTOR_OIDC_ISSUER", "http://localhost:7080/realms/example")
  monkeypatch.setenv("INGESTOR_OIDC_CLIENT_ID", "example-ingestor")
  monkeypatch.setenv("INGESTOR_OIDC_CLIENT_SECRET", "example-secret")

  client = Client("primary", "slack")
  client._fetch_discovery = AsyncMock(side_effect=OSError("identity service unavailable"))

  fallback = asyncio.run(client._discover_token_endpoint())
  assert fallback == "http://localhost:7080/realms/example/protocol/openid-connect/token"
  assert client._token_endpoint is None

  asyncio.run(client._discover_token_endpoint())
  assert client._fetch_discovery.await_count == 4
