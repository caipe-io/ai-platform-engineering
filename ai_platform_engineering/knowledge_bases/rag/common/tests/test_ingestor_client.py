"""Focused tests for the shared authenticated RAG ingestor client."""

import asyncio
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
import tenacity
from langchain_core.documents import Document

from common.ingestor import Client, _wait_for_retry_after
from common.models.server import AuthHeader


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
    self.payloads = []

  def post(self, *args, **kwargs):
    self.post_count += 1
    self.payloads.append(kwargs["json"]["documents"])
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


def test_resolve_auth_headers_rejects_a_non_https_url() -> None:
  """A configured header must never go out on a request the crawl itself
  makes over plain HTTP — that is the wire, not a redirect edge case."""
  client = Client("primary", "webloader")
  client.retrieve_secret = AsyncMock(side_effect=AssertionError("must not be called"))
  headers = [AuthHeader(header_name="X-Api-Key", value_template="static-value")]

  with pytest.raises(ValueError, match="non-HTTPS"):
    asyncio.run(client.resolve_auth_headers("http://docs.example.com/", headers))

  client.retrieve_secret.assert_not_awaited()


def test_resolve_auth_headers_allows_a_static_header_over_https() -> None:
  client = Client("primary", "webloader")
  headers = [AuthHeader(header_name="X-Api-Key", value_template="static-value")]

  rendered, labels = asyncio.run(
    client.resolve_auth_headers("https://docs.example.com/", headers)
  )

  assert rendered == {"X-Api-Key": "static-value"}
  assert labels == []


def test_resolve_auth_headers_ignores_scheme_when_nothing_is_configured() -> None:
  client = Client("primary", "webloader")

  rendered, labels = asyncio.run(client.resolve_auth_headers("http://docs.example.com/", None))

  assert rendered == {}
  assert labels == []


@pytest.fixture(autouse=True)
def _no_retry_wait(monkeypatch: pytest.MonkeyPatch) -> None:
  """Skip real backoff in tests; monkeypatch restores the shared retry policy after each test."""
  monkeypatch.setattr(Client._post_ingest_request.retry, "wait", tenacity.wait_none())


def _client_ready_to_post() -> Client:
  client = Client("primary", "webloader")
  client.ingestor_id = "ing-1"
  client._get_auth_headers = AsyncMock(return_value={})
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
  assert [[doc["page_content"] for doc in batch] for batch in fake_session.payloads] == [
    ["a", "b"],
    ["a"],
    ["b"],
  ]


def test_ingest_batch_does_not_retry_a_non_transient_error() -> None:
  """A plain server error (not 429/413) must still fail immediately, unaffected by the fix."""
  client = _client_ready_to_post()
  fake_session = _FakeIngestSession([500])

  with patch("common.ingestor.aiohttp.ClientSession", return_value=fake_session):
    with pytest.raises(aiohttp.ClientResponseError, match="boom"):
      asyncio.run(client._ingest_documents_batch("job-1", "ds-1", [Document(page_content="x")], 0))

  assert fake_session.post_count == 1


class _FakeRetryState:
  """Stands in for tenacity.RetryCallState: only the fields _wait_for_retry_after reads."""

  def __init__(self, exc: BaseException, attempt_number: int = 1) -> None:
    self.outcome = MagicMock()
    self.outcome.exception.return_value = exc
    self.attempt_number = attempt_number


def _rate_limited_error(headers: dict) -> aiohttp.ClientResponseError:
  return aiohttp.ClientResponseError(request_info=MagicMock(), history=(), status=429, headers=headers)


def test_wait_for_retry_after_honors_the_header() -> None:
  exc = _rate_limited_error({"Retry-After": "5"})
  assert _wait_for_retry_after(_FakeRetryState(exc)) == 5.0


def test_wait_for_retry_after_caps_a_long_header_at_sixty_seconds() -> None:
  exc = _rate_limited_error({"Retry-After": "9000"})
  assert _wait_for_retry_after(_FakeRetryState(exc)) == 60.0


def test_wait_for_retry_after_falls_back_to_backoff_without_a_header() -> None:
  exc = _rate_limited_error({})
  assert _wait_for_retry_after(_FakeRetryState(exc, attempt_number=2)) == 2.0


def test_wait_for_retry_after_honors_a_future_http_date() -> None:
  future = datetime.now(timezone.utc) + timedelta(seconds=10)
  exc = _rate_limited_error({"Retry-After": format_datetime(future, usegmt=True)})
  wait = _wait_for_retry_after(_FakeRetryState(exc))
  assert 8.0 <= wait <= 10.0


def test_wait_for_retry_after_caps_a_far_future_http_date_at_sixty_seconds() -> None:
  future = datetime.now(timezone.utc) + timedelta(hours=1)
  exc = _rate_limited_error({"Retry-After": format_datetime(future, usegmt=True)})
  assert _wait_for_retry_after(_FakeRetryState(exc)) == 60.0


def test_wait_for_retry_after_falls_back_to_backoff_on_a_past_http_date() -> None:
  past = datetime.now(timezone.utc) - timedelta(seconds=10)
  exc = _rate_limited_error({"Retry-After": format_datetime(past, usegmt=True)})
  assert _wait_for_retry_after(_FakeRetryState(exc, attempt_number=2)) == 2.0


def test_wait_for_retry_after_falls_back_to_backoff_on_a_non_ascii_digit() -> None:
  # str.isdigit() is true for Unicode digits like superscript two; float() rejects them.
  exc = _rate_limited_error({"Retry-After": "²"})
  assert _wait_for_retry_after(_FakeRetryState(exc, attempt_number=2)) == 2.0
