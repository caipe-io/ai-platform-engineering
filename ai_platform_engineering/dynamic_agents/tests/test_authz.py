"""Unit tests for Dynamic Agents agent-use authorization (delegated to CAS)."""

from __future__ import annotations

import base64
import json

import pytest
from fastapi import HTTPException

from dynamic_agents.auth.token_context import current_traceparent, current_user_token


def _fake_jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"{header}.{body}."


class _Resp:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


def _client(captured: list, response: _Resp):
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, **kwargs):
            captured.append((url, kwargs.get("headers"), kwargs.get("json")))
            return response

    return FakeClient


@pytest.mark.asyncio
async def test_allows_when_cas_allows(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://caipe-ui:3000")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        await authz.require_agent_use_permission("agent-1")  # no raise
    finally:
        current_user_token.reset(token_ref)

    assert posts
    url, headers, body = posts[-1]
    assert url == "http://caipe-ui:3000/api/authz/v1/decisions"
    assert headers["Authorization"].startswith("Bearer ")
    assert body == {
        "subject": {"type": "user", "id": "alice-sub"},
        "resource": {"type": "agent", "id": "agent-1"},
        "action": "use",
    }


@pytest.mark.asyncio
async def test_service_account_token_sends_service_account_subject(monkeypatch):
    """A service-account OBO token (preferred_username starting with
    `service-account-`) must be sent to CAS as a `service_account` subject so its
    subject-binding (caller == subject) holds; sending `user` 403s the call."""
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://caipe-ui:3000")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    token = _fake_jwt({"sub": "sa-sub", "preferred_username": "service-account-caipe-sa-gitlab"})
    token_ref = current_user_token.set(token)
    try:
        await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)

    assert posts
    _url, _headers, body = posts[-1]
    assert body["subject"] == {"type": "service_account", "id": "sa-sub"}


@pytest.mark.asyncio
async def test_service_account_delegates_decision_to_owner_subject(monkeypatch):
    """Unattended (autonomous) runs: a service-account bearer that supplies the
    owner's sub must have the decision evaluated on the OWNER (user:<sub>), not
    the service account — so group-shared agents and revocation work. The
    forwarded bearer is still the service account's (CAS binds the cross-subject
    evaluation via can_audit on that caller)."""
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    token = _fake_jwt({"sub": "sa-sub", "preferred_username": "service-account-caipe-platform"})
    token_ref = current_user_token.set(token)
    try:
        await authz.require_agent_use_permission("agent-1", delegated_user_sub="owner-uuid")
    finally:
        current_user_token.reset(token_ref)

    assert posts
    _url, _headers, body = posts[-1]
    assert body["subject"] == {"type": "user", "id": "owner-uuid"}


@pytest.mark.asyncio
async def test_user_bearer_cannot_delegate_to_another_subject(monkeypatch):
    """A user (interactive) bearer may never assert a different subject: the
    delegation branch is gated on the bearer being a service account, so the
    decision stays bound to the user's own sub even if a delegated sub is
    passed."""
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        await authz.require_agent_use_permission("agent-1", delegated_user_sub="victim-uuid")
    finally:
        current_user_token.reset(token_ref)

    assert posts[-1][2]["subject"] == {"type": "user", "id": "alice-sub"}


@pytest.mark.asyncio
async def test_invalid_delegated_subject_returns_400_without_calling_cas(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")

    def must_not_construct(*a, **k):
        raise AssertionError("CAS must not be called for an invalid delegated subject")

    monkeypatch.setattr(authz.httpx, "AsyncClient", must_not_construct)
    token = _fake_jwt({"sub": "sa-sub", "preferred_username": "service-account-caipe-platform"})
    token_ref = current_user_token.set(token)
    try:
        with pytest.raises(HTTPException) as exc:
            await authz.require_agent_use_permission("agent-1", delegated_user_sub="bad/sub")
    finally:
        current_user_token.reset(token_ref)
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "invalid_delegated_subject"


@pytest.mark.asyncio
async def test_service_account_without_delegated_sub_stays_service_account(monkeypatch):
    """A service-account bearer with no owner sub (e.g. a legacy task) is still
    evaluated as the service account — the delegation is opt-in, so behaviour is
    unchanged when no owner is asserted."""
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    token = _fake_jwt({"sub": "sa-sub", "preferred_username": "service-account-caipe-platform"})
    token_ref = current_user_token.set(token)
    try:
        await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)

    assert posts[-1][2]["subject"] == {"type": "service_account", "id": "sa-sub"}


@pytest.mark.asyncio
async def test_strips_trailing_slash_from_service_url(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://caipe-ui:3000/")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)

    assert posts[-1][0] == "http://caipe-ui:3000/api/authz/v1/decisions"


@pytest.mark.asyncio
async def test_denies_when_cas_denies(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client([], _Resp(200, {"decision": "DENY"})))

    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        with pytest.raises(HTTPException) as exc:
            await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)

    assert exc.value.status_code == 403
    assert exc.value.detail["reason"] == "pdp_denied"


@pytest.mark.asyncio
async def test_fails_closed_on_5xx(monkeypatch):
    """A transient 5xx from CAS denies via 503/retry — fail closed."""
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client([], _Resp(503)))

    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        with pytest.raises(HTTPException) as exc:
            await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)

    assert exc.value.status_code == 503
    assert exc.value.detail["reason"] == "pdp_unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize("cas_status", [400, 401, 403])
async def test_cas_4xx_surfaces_as_same_status_not_503(monkeypatch, cas_status):
    """A definitive 4xx from CAS (e.g. 403 subject-binding) is not transient, so
    it surfaces as the same status with a non-retriable reason — not 503/retry."""
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client([], _Resp(cas_status)))

    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        with pytest.raises(HTTPException) as exc:
            await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)

    assert exc.value.status_code == cas_status
    assert exc.value.detail["reason"] == "pdp_rejected"


@pytest.mark.asyncio
async def test_fails_closed_when_service_url_unset(monkeypatch):
    """No AUTHZ_SERVICE_URL → DA cannot get a decision → deny via 503."""
    from dynamic_agents.auth import authz

    monkeypatch.delenv("AUTHZ_SERVICE_URL", raising=False)
    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        with pytest.raises(HTTPException) as exc:
            await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)

    assert exc.value.status_code == 503
    assert exc.value.detail["reason"] == "pdp_unavailable"


@pytest.mark.asyncio
async def test_forwards_traceparent_to_cas(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
    tp_ref = current_traceparent.set(traceparent)
    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)
        current_traceparent.reset(tp_ref)

    assert posts[-1][1]["traceparent"] == traceparent


@pytest.mark.asyncio
async def test_missing_bearer_returns_401():
    from dynamic_agents.auth import authz

    with pytest.raises(HTTPException) as exc:
        await authz.require_agent_use_permission("agent-1")
    assert exc.value.status_code == 401
    assert exc.value.detail["code"] == "missing_bearer"


@pytest.mark.asyncio
async def test_token_without_subject_returns_401():
    from dynamic_agents.auth import authz

    token_ref = current_user_token.set(_fake_jwt({"email": "alice@example.com"}))
    try:
        with pytest.raises(HTTPException) as exc:
            await authz.require_agent_use_permission("agent-1")
    finally:
        current_user_token.reset(token_ref)
    assert exc.value.status_code == 401
    assert exc.value.detail["code"] == "bearer_invalid"


@pytest.mark.asyncio
async def test_invalid_agent_id_returns_400_without_calling_cas(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")

    def must_not_construct(*a, **k):
        raise AssertionError("CAS must not be called for an invalid agent id")

    monkeypatch.setattr(authz.httpx, "AsyncClient", must_not_construct)
    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        with pytest.raises(HTTPException) as exc:
            await authz.require_agent_use_permission("../agent-1")
    finally:
        current_user_token.reset(token_ref)
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "invalid_agent_id"
