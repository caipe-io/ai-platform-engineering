"""Unit tests for the user-level Autonomous entitlement check."""

from __future__ import annotations

import base64
import json

import pytest
from fastapi import HTTPException

from dynamic_agents.auth.token_context import current_user_token


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
async def test_autonomous_allowed_checks_organization_capability(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        await authz.require_autonomous_permission()  # no raise
    finally:
        current_user_token.reset(token_ref)

    assert posts
    _url, _headers, body = posts[-1]
    assert body == {
        "subject": {"type": "user", "id": "alice-sub"},
        "resource": {"type": "organization", "id": "caipe"},
        "action": "automate",
    }


@pytest.mark.asyncio
async def test_autonomous_denied_raises_403_organization_automate(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "DENY"})))

    token_ref = current_user_token.set(_fake_jwt({"sub": "alice-sub"}))
    try:
        with pytest.raises(HTTPException) as exc:
            await authz.require_autonomous_permission()
    finally:
        current_user_token.reset(token_ref)
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "organization#automate"


@pytest.mark.asyncio
async def test_autonomous_delegates_to_owner_subject_for_service_account(monkeypatch):
    from dynamic_agents.auth import authz

    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://cas")
    posts: list = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", _client(posts, _Resp(200, {"decision": "ALLOW"})))

    token = _fake_jwt({"sub": "sa-sub", "preferred_username": "service-account-caipe-platform"})
    token_ref = current_user_token.set(token)
    try:
        await authz.require_autonomous_permission(delegated_user_sub="owner-uuid")
    finally:
        current_user_token.reset(token_ref)

    assert posts
    _url, _headers, body = posts[-1]
    assert body["subject"] == {"type": "user", "id": "owner-uuid"}
    assert body["resource"] == {"type": "organization", "id": "caipe"}
    assert body["action"] == "automate"
