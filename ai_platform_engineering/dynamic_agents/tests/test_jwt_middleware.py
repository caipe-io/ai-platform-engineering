"""Unit tests for ``dynamic_agents.auth.jwt_middleware`` (Spec 102 T110).

Covers all four branches of ``JwtAuthMiddleware.dispatch``:

1. No Authorization header, ``DA_REQUIRE_BEARER`` off  -> request passes,
   ``current_user_token`` stays None (legacy X-User-Context path).
2. No Authorization header, ``DA_REQUIRE_BEARER`` on  -> 401 with
   ``code=missing_bearer`` and structured body.
3. Valid Bearer  -> ``current_user_token`` set to the raw token, request
   reaches the handler, contextvar reset on the way out.
4. Invalid Bearer  -> 401 with ``code=bearer_invalid`` (NEVER falls
   through to the legacy header path; this is the security boundary).
5. The unset ``DA_REQUIRE_BEARER`` variable defaults to strict mode.
"""

from __future__ import annotations

import importlib
import json
from typing import Any

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient


def _build_app(monkeypatch, *, require_bearer: bool, validator):
    """Build a fresh Starlette app with the middleware reloaded.

    The middleware reads ``DA_REQUIRE_BEARER`` at import time, so we
    re-import it under each scenario after monkeypatching the env.
    """
    monkeypatch.setenv("DA_REQUIRE_BEARER", "true" if require_bearer else "")

    from dynamic_agents.auth import jwt_middleware as mw

    importlib.reload(mw)

    monkeypatch.setattr(mw, "_validate_bearer_or_none", validator)

    from dynamic_agents.auth.token_context import current_user_token

    seen: dict[str, Any] = {}

    async def handler(request: Request) -> JSONResponse:
        seen["token"] = current_user_token.get()
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/echo", handler, methods=["GET"])])
    app.add_middleware(mw.JwtAuthMiddleware)
    return app, seen


def test_no_bearer_lenient_passes_through(monkeypatch):
    app, seen = _build_app(
        monkeypatch, require_bearer=False, validator=lambda _t: {"sub": "x"}
    )
    with TestClient(app) as client:
        resp = client.get("/echo")
    assert resp.status_code == 200
    assert seen["token"] is None


def test_no_bearer_strict_returns_401(monkeypatch):
    app, _ = _build_app(
        monkeypatch, require_bearer=True, validator=lambda _t: {"sub": "x"}
    )
    with TestClient(app) as client:
        resp = client.get("/echo")
    assert resp.status_code == 401
    body = json.loads(resp.text)
    assert body["code"] == "missing_bearer"
    assert body["reason"] == "not_signed_in"
    assert body["action"] == "sign_in"


def test_no_bearer_defaults_to_strict(monkeypatch):
    monkeypatch.delenv("DA_REQUIRE_BEARER", raising=False)
    from dynamic_agents.auth import jwt_middleware as mw

    importlib.reload(mw)
    app = Starlette(routes=[Route("/echo", lambda _request: JSONResponse({"ok": True}))])
    app.add_middleware(mw.JwtAuthMiddleware)

    with TestClient(app) as client:
        resp = client.get("/echo")

    assert resp.status_code == 401
    assert resp.json()["code"] == "missing_bearer"


@pytest.mark.parametrize("path", ["/health", "/healthz", "/readyz", "/metrics"])
def test_operational_endpoints_bypass_strict_bearer_requirement(monkeypatch, path):
    """Health endpoints must stay probeable without auth."""
    app, seen = _build_app(
        monkeypatch, require_bearer=True, validator=lambda _t: {"sub": "x"}
    )

    async def health_handler(request: Request) -> JSONResponse:
        seen["token"] = None
        return JSONResponse({"status": "healthy"})

    app.router.routes.append(Route(path, health_handler, methods=["GET"]))

    with TestClient(app) as client:
        resp = client.get(path)

    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


def test_options_preflight_bypasses_strict_bearer_requirement(monkeypatch):
    app, _ = _build_app(
        monkeypatch, require_bearer=True, validator=lambda _t: {"sub": "user-primary"}
    )

    async def options_handler(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    app.router.routes.append(Route("/resource", options_handler, methods=["OPTIONS"]))

    with TestClient(app) as client:
        resp = client.options("/resource")

    assert resp.status_code == 200


def test_valid_bearer_binds_contextvar(monkeypatch):
    app, seen = _build_app(
        monkeypatch,
        require_bearer=False,
        validator=lambda _t: {"sub": "alice", "aud": "dynamic-agents"},
    )
    with TestClient(app) as client:
        resp = client.get("/echo", headers={"Authorization": "Bearer good.jwt.here"})
    assert resp.status_code == 200
    assert seen["token"] == "good.jwt.here"

    # Contextvar must be reset across requests so token does not leak
    # to a subsequent unauthenticated call.
    seen.clear()
    with TestClient(app) as client:
        resp = client.get("/echo")
    assert resp.status_code == 200
    assert seen["token"] is None


def test_invalid_bearer_rejects_with_401_and_does_not_fallthrough(monkeypatch):
    app, seen = _build_app(
        monkeypatch, require_bearer=False, validator=lambda _t: None
    )
    with TestClient(app) as client:
        resp = client.get("/echo", headers={"Authorization": "Bearer forged"})
    assert resp.status_code == 401
    body = json.loads(resp.text)
    assert body["code"] == "bearer_invalid"
    assert body["reason"] == "bearer_invalid"
    # Critical: the handler must NOT have run — we never want a forged
    # Bearer to silently fall through to the X-User-Context legacy path.
    assert "token" not in seen


def test_empty_bearer_value_is_treated_as_no_bearer(monkeypatch):
    """``Authorization: Bearer `` with whitespace only must not 401 in lenient mode."""
    app, seen = _build_app(
        monkeypatch, require_bearer=False, validator=lambda _t: {"sub": "x"}
    )
    with TestClient(app) as client:
        resp = client.get("/echo", headers={"Authorization": "Bearer    "})
    assert resp.status_code == 200
    assert seen["token"] is None


@pytest.mark.parametrize("scheme", ["basic", "BEARER", "bearer"])
def test_bearer_scheme_match_is_case_insensitive(monkeypatch, scheme):
    app, seen = _build_app(
        monkeypatch, require_bearer=False, validator=lambda _t: {"sub": "x"}
    )
    with TestClient(app) as client:
        resp = client.get("/echo", headers={"Authorization": f"{scheme} tkn"})
    if scheme.lower() == "bearer":
        assert resp.status_code == 200
        assert seen["token"] == "tkn"
    else:
        # Non-Bearer scheme: middleware ignores it entirely.
        assert resp.status_code == 200
        assert seen["token"] is None
