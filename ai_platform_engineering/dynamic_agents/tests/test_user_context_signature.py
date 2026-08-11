import base64
import hashlib
import hmac
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from dynamic_agents.auth.auth import get_user_context


def _request(context: dict, secret: str, *, signature_override: str | None = None) -> Request:
    encoded = base64.b64encode(json.dumps(context).encode("utf-8")).decode("ascii")
    signature = "v1=" + hmac.new(
        secret.encode("utf-8"),
        encoded.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    headers = [
        (b"x-user-context", encoded.encode("ascii")),
        (
            b"x-user-context-signature",
            (signature_override or signature).encode("ascii"),
        ),
    ]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers})


@pytest.mark.asyncio
async def test_accepts_signed_user_context(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DA_USER_CONTEXT_HMAC_SECRET", "context-secret")
    request = _request(
        {"email": "user@example.com", "name": "Example User", "is_admin": False},
        "context-secret",
    )

    user = await get_user_context(request, SimpleNamespace(debug=False))

    assert user.email == "user@example.com"
    assert user.is_admin is False


@pytest.mark.asyncio
async def test_rejects_context_with_invalid_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DA_USER_CONTEXT_HMAC_SECRET", "context-secret")
    request = _request(
        {"email": "user@example.com", "is_admin": True},
        "context-secret",
        signature_override="v1=invalid",
    )

    with pytest.raises(HTTPException) as exc_info:
        await get_user_context(request, SimpleNamespace(debug=False))

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_fails_closed_when_signature_secret_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DA_USER_CONTEXT_HMAC_SECRET", raising=False)
    request = _request({"email": "user@example.com"}, "unused-secret")

    with pytest.raises(HTTPException) as exc_info:
        await get_user_context(request, SimpleNamespace(debug=False))

    assert exc_info.value.status_code == 503
