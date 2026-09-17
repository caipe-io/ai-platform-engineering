"""Unit tests for ``dynamic_agents.auth.obo_exchange`` (Spec 102 T111).

We do not stand up Keycloak; instead we monkeypatch ``httpx.AsyncClient.post``
so the test verifies the exchange request shape, the cache, and the
graceful-fallback contract.
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass

import pytest

from dynamic_agents.auth import obo_exchange


def _fake_jwt(sub: str) -> str:
    """Build an unsigned JWT whose payload has ``sub=<sub>``.

    The real validation happens in the middleware; ``impersonate_user``
    only decodes ``sub`` (unverified) for the cache key.
    """
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = (
        base64.urlsafe_b64encode(json.dumps({"sub": sub}).encode())
        .rstrip(b"=")
        .decode()
    )
    return f"{header}.{payload}."


@dataclass
class _FakeResp:
    status_code: int
    _body: dict

    @property
    def text(self) -> str:
        return json.dumps(self._body)

    def json(self) -> dict:
        return self._body


class _FakeClient:
    def __init__(self, resp: _FakeResp, calls: list[dict]):
        self._resp = resp
        self._calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def post(self, url, *, data, headers):
        self._calls.append({"url": url, "data": data, "headers": headers})
        return self._resp


@pytest.fixture(autouse=True)
def _isolate_cache_and_warning():
    obo_exchange.clear_obo_cache()
    yield
    obo_exchange.clear_obo_cache()


@pytest.fixture
def _kc_env(monkeypatch):
    monkeypatch.setenv("KEYCLOAK_DA_CLIENT_ID", "dynamic-agents")
    monkeypatch.setenv("KEYCLOAK_DA_CLIENT_SECRET", "shh")
    monkeypatch.setenv(
        "OIDC_ISSUER", "http://kc.example/realms/caipe"
    )


@pytest.mark.asyncio
async def test_returns_none_when_oidc_not_configured(monkeypatch):
    monkeypatch.delenv("KEYCLOAK_DA_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("OIDC_ISSUER", raising=False)
    monkeypatch.delenv("OIDC_DISCOVERY_URL", raising=False)
    out = await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")
    assert out is None


@pytest.mark.asyncio
async def test_successful_exchange_returns_new_token(monkeypatch, _kc_env):
    calls: list[dict] = []
    resp = _FakeResp(
        200, {"access_token": "obo-1", "expires_in": 300, "token_type": "Bearer"}
    )
    monkeypatch.setattr(
        obo_exchange.httpx, "AsyncClient", lambda *_a, **_kw: _FakeClient(resp, calls)
    )

    out = await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")
    assert out == "obo-1"
    assert calls and calls[0]["url"].endswith(
        "/realms/caipe/protocol/openid-connect/token"
    )
    body = calls[0]["data"]
    assert body["grant_type"] == obo_exchange._OBO_GRANT_TYPE
    assert body["audience"] == "agentgateway"
    assert body["client_id"] == "dynamic-agents"
    assert body["client_secret"] == "shh"
    assert body["subject_token"] == _fake_jwt("alice")


@pytest.mark.asyncio
async def test_prefers_server_side_discovery_url_over_browser_issuer(monkeypatch, _kc_env):
    monkeypatch.setenv(
        "OIDC_DISCOVERY_URL", "http://caipe-keycloak:8080/realms/caipe"
    )
    calls: list[dict] = []
    resp = _FakeResp(
        200, {"access_token": "obo-internal", "expires_in": 300, "token_type": "Bearer"}
    )
    monkeypatch.setattr(
        obo_exchange.httpx, "AsyncClient", lambda *_a, **_kw: _FakeClient(resp, calls)
    )

    out = await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")

    assert out == "obo-internal"
    assert calls[0]["url"] == (
        "http://caipe-keycloak:8080/realms/caipe/"
        "protocol/openid-connect/token"
    )


@pytest.mark.asyncio
async def test_cache_hit_skips_second_exchange(monkeypatch, _kc_env):
    calls: list[dict] = []
    resp = _FakeResp(200, {"access_token": "obo-1", "expires_in": 600})
    monkeypatch.setattr(
        obo_exchange.httpx, "AsyncClient", lambda *_a, **_kw: _FakeClient(resp, calls)
    )

    one = await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")
    two = await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")
    assert one == "obo-1"
    assert two == "obo-1"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_cache_misses_on_different_user(monkeypatch, _kc_env):
    calls: list[dict] = []
    resp = _FakeResp(200, {"access_token": "obo-x", "expires_in": 600})
    monkeypatch.setattr(
        obo_exchange.httpx, "AsyncClient", lambda *_a, **_kw: _FakeClient(resp, calls)
    )
    await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")
    await obo_exchange.impersonate_user(_fake_jwt("bob"), "agentgateway")
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_cache_expires_within_safety_margin(monkeypatch, _kc_env):
    """A cached token expiring within the 30s safety margin must be re-minted."""
    calls: list[dict] = []
    resp = _FakeResp(200, {"access_token": "obo-1", "expires_in": 5})
    monkeypatch.setattr(
        obo_exchange.httpx, "AsyncClient", lambda *_a, **_kw: _FakeClient(resp, calls)
    )
    await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")
    # Force the cache entry to look "near-expiry".
    key = next(iter(obo_exchange._obo_cache))
    obo_exchange._obo_cache[key].expires_at = time.time() + 5
    await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_keycloak_5xx_returns_none(monkeypatch, _kc_env):
    calls: list[dict] = []
    resp = _FakeResp(500, {"error": "server"})
    monkeypatch.setattr(
        obo_exchange.httpx, "AsyncClient", lambda *_a, **_kw: _FakeClient(resp, calls)
    )
    out = await obo_exchange.impersonate_user(_fake_jwt("alice"), "agentgateway")
    assert out is None


@pytest.mark.asyncio
async def test_unparseable_subject_returns_none(monkeypatch, _kc_env):
    out = await obo_exchange.impersonate_user("not-a-jwt", "agentgateway")
    assert out is None
