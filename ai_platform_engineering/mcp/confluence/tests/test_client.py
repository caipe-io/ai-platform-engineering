from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from api import client


def install_transport(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    real_client = httpx.AsyncClient
    monkeypatch.setattr(client.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))


@pytest.mark.parametrize(("base", "path", "expected"), [
    ("https://example.test/rest/api", "/search", "https://example.test/rest/api/search"),
    ("https://example.test", "/search", "https://example.test/wiki/rest/api/search"),
    ("https://example.test/wiki/rest/api", "/content", "https://example.test/wiki/rest/api/content"),
    ("https://api.atlassian.com/ex/confluence/example", "/api/v2/pages/123", "https://api.atlassian.com/ex/confluence/example/wiki/api/v2/pages/123"),
    ("https://api.atlassian.com/ex/confluence/example/wiki", "/wiki/rest/api/search", "https://api.atlassian.com/ex/confluence/example/wiki/rest/api/search"),
])
def test_routes_keep_wiki_context(base: str, path: str, expected: str) -> None:
    assert client.api_request_url(base, path) == expected


def test_missing_forwarded_oauth_never_uses_static_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client, "get_provider_header_token", lambda: None)
    monkeypatch.setattr(client, "_request_has_caipe_provider_header", lambda: True)
    static_token = AsyncMock()
    monkeypatch.setattr(client, "get_env", static_token)
    ok, error = client.validate_prerequisites()
    assert ok is False and "not connected" in error["error"]
    static_token.assert_not_called()


@pytest.mark.asyncio
async def test_oauth_selects_configured_site_and_preserves_caller_token(monkeypatch: pytest.MonkeyPatch) -> None:
    client._CLOUD_ID_CACHE.clear()
    monkeypatch.delenv("ATLASSIAN_OAUTH_CLOUD_ID", raising=False)
    monkeypatch.setattr(client, "validate_prerequisites", lambda **kwargs: (True, {"token": "example-token", "email": "", "url": "https://example.test/wiki", "auth_scheme": "bearer"}))
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer example-token"
        if "accessible-resources" in str(request.url):
            return httpx.Response(200, json=[{"id": "other", "url": "https://other.test"}, {"id": "selected", "url": "https://example.test"}])
        assert str(request.url) == "https://api.atlassian.com/ex/confluence/selected/wiki/rest/api/search"
        return httpx.Response(200, json={"results": []})

    install_transport(monkeypatch, handle)
    assert (await client.make_api_request("/search"))[0] is True
    assert len(requests) == 2


@pytest.mark.asyncio
async def test_unresolvable_site_never_falls_back_to_tenant_or_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client, "validate_prerequisites", lambda **kwargs: (True, {"token": "example-token", "email": "", "url": "https://example.test", "auth_scheme": "bearer"}))
    resolver = AsyncMock(return_value=None)
    monkeypatch.setattr(client, "resolve_oauth_base_url", resolver)
    ok, error = await client.make_api_request("/search")
    assert ok is False and error["code"] == "site_resolution"


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "status", "count"), [("GET", 401, 1), ("GET", 403, 1), ("GET", 502, 3), ("POST", 502, 1)])
async def test_retry_policy_never_replays_writes_or_auth_failures(monkeypatch: pytest.MonkeyPatch, method: str, status: int, count: int) -> None:
    monkeypatch.setattr(client, "validate_prerequisites", lambda **kwargs: (True, {"token": "example-token", "email": "test-user@example.test", "url": "https://example.test/wiki", "auth_scheme": "basic"}))
    monkeypatch.setattr(client.asyncio, "sleep", AsyncMock())
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, text="provider error", headers={"Retry-After": "invalid"})

    install_transport(monkeypatch, handle)
    ok, error = await client.make_api_request("/content", method=method)
    assert ok is False and error["status"] == status
    assert len(requests) == count
    assert error["retryable"] is (method == "GET" and status == 502)
    assert "provider error" not in str(error)


@pytest.mark.asyncio
async def test_html_login_is_not_successful_page_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client, "validate_prerequisites", lambda **kwargs: (True, {"token": "example-token", "email": "test-user@example.test", "url": "https://example.test/wiki", "auth_scheme": "basic"}))
    install_transport(monkeypatch, lambda request: httpx.Response(200, text="<html>Sign in</html>"))
    ok, error = await client.make_api_request("/search")
    assert ok is False and error["code"] == "invalid_response"
