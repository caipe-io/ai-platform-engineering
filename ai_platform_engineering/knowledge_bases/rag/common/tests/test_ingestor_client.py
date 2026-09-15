"""Focused tests for the shared authenticated RAG ingestor client."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
import tenacity
from langchain_core.documents import Document

from common.ingestor import Client


class _FakeIngestResponse:
  """Stands in for the aiohttp response `_post_ingest_request` awaits on."""

  def __init__(self, status: int) -> None:
    self.status = status

  def raise_for_status(self) -> None:
    if self.status >= 400:
      raise aiohttp.ClientResponseError(request_info=MagicMock(), history=(), status=self.status, message="boom")

  async def json(self):
    return {"ok": True}

  async def __aenter__(self):
    return self

  async def __aexit__(self, *exc):
    return False


class _FakeIngestSession:
  """Stands in for `aiohttp.ClientSession`, returning one queued status per POST."""

  def __init__(self, statuses: list) -> None:
    self._statuses = list(statuses)
    self.post_count = 0

  def post(self, *args, **kwargs):
    self.post_count += 1
    status = self._statuses.pop(0) if self._statuses else 200
    return _FakeIngestResponse(status)

  async def __aenter__(self):
    return self

  async def __aexit__(self, *exc):
    return False


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


def _client_ready_to_post() -> Client:
  client = Client("primary", "webloader")
  client.ingestor_id = "ing-1"
  client._get_auth_headers = AsyncMock(return_value={})
  client._post_ingest_request.retry.wait = tenacity.wait_none()
  return client


def test_ingest_batch_retries_a_429_instead_of_aborting_the_job() -> None:
  """A single transient 429 must not abort the whole ingestion job (issue #558)."""
  client = _client_ready_to_post()
  fake_session = _FakeIngestSession([429])

  with patch("common.ingestor.aiohttp.ClientSession", return_value=fake_session):
    result = asyncio.run(client._ingest_documents_batch("job-1", "ds-1", [Document(page_content="x")], 0))

  assert result == {"ok": True}
  assert fake_session.post_count == 2


def test_ingest_batch_gives_up_after_repeated_429s() -> None:
  """The retry is bounded: a server stuck at 429 must still fail, not hang forever."""
  client = _client_ready_to_post()
  fake_session = _FakeIngestSession([429, 429, 429, 429, 429])

  with patch("common.ingestor.aiohttp.ClientSession", return_value=fake_session):
    with pytest.raises(aiohttp.ClientResponseError, match="boom"):
      asyncio.run(client._ingest_documents_batch("job-1", "ds-1", [Document(page_content="x")], 0))

  assert fake_session.post_count == 5


def test_ingest_batch_splits_and_retries_on_413() -> None:
  """A 413 (batch too large) must retry as smaller batches, not abort the job."""
  client = _client_ready_to_post()
  # First POST (2 docs) -> 413; the resulting two 1-doc POSTs both succeed.
  fake_session = _FakeIngestSession([413])
  documents = [Document(page_content="a"), Document(page_content="b")]

  with patch("common.ingestor.aiohttp.ClientSession", return_value=fake_session):
    result = asyncio.run(client._ingest_documents_batch("job-1", "ds-1", documents, 0))

  assert result == {"ok": True}
  assert fake_session.post_count == 3  # 1 rejected batch + 2 split retries


def test_ingest_batch_does_not_retry_a_non_transient_error() -> None:
  """A plain server error (not 429/413) must still fail immediately, unaffected by the fix."""
  client = _client_ready_to_post()
  fake_session = _FakeIngestSession([500])

  with patch("common.ingestor.aiohttp.ClientSession", return_value=fake_session):
    with pytest.raises(aiohttp.ClientResponseError, match="boom"):
      asyncio.run(client._ingest_documents_batch("job-1", "ds-1", [Document(page_content="x")], 0))

  assert fake_session.post_count == 1
