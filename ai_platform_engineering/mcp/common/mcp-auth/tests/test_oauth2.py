# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""End-to-end tests for ``MCP_AUTH_MODE=oauth2``.

We mint a real RSA keypair, install it as the JWKS source via a
monkey-patched ``JwksCache``, and assert the middleware accepts /
rejects JWTs based on iss/aud/exp/algorithm/kid as required by the
codeguard cryptography rules (no string concatenation, real signature
verification, JWKS-based key lookup).
"""

from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient


# ---------------------------------------------------------------------------
# RSA keypair + JWKS helpers
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def rsa_keypair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_numbers = private.public_key().public_numbers()
    n_bytes = public_numbers.n.to_bytes(
        (public_numbers.n.bit_length() + 7) // 8, "big"
    )
    e_bytes = public_numbers.e.to_bytes(
        (public_numbers.e.bit_length() + 7) // 8, "big"
    )
    import base64

    def _b64u(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")

    jwk = {
        "kty": "RSA",
        "kid": "test-kid-1",
        "alg": "RS256",
        "use": "sig",
        "n": _b64u(n_bytes),
        "e": _b64u(e_bytes),
    }
    return private_pem, jwk


def _mint(
    private_pem: bytes,
    *,
    iss: str = "https://issuer.example",
    aud: str = "mcp-test",
    kid: str = "test-kid-1",
    exp_offset: int = 600,
    extra: dict[str, Any] | None = None,
) -> str:
    payload = {
        "iss": iss,
        "aud": aud,
        "sub": "user-1",
        "iat": int(time.time()),
        "exp": int(time.time()) + exp_offset,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, private_pem, algorithm="RS256", headers={"kid": kid})


def _install_jwks(monkeypatch, mod, jwk):
    """Replace the module-level JWKS cache with one that returns ``jwk``."""

    class FakeCache:
        def __init__(self, *_, **__):
            pass

        def get_jwk(self, kid):
            return jwk if kid == jwk["kid"] else None

        def refresh(self):
            pass

    monkeypatch.setattr(mod, "JwksCache", FakeCache)
    monkeypatch.setattr(mod, "_jwks_cache", FakeCache())


def _client(mod) -> TestClient:
    async def ok(request):
        return PlainTextResponse("ok")

    app = Starlette(
        routes=[Route("/", ok)],
        middleware=[Middleware(mod.MCPAuthMiddleware)],
    )
    return TestClient(app)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_oauth2_accepts_valid_jwt(reload_middleware, rsa_keypair, monkeypatch):
    private_pem, jwk = rsa_keypair
    mod = reload_middleware(
        {
            "MCP_AUTH_MODE": "oauth2",
            "JWKS_URI": "https://issuer.example/jwks",
            "AUDIENCE": "mcp-test",
            "ISSUER": "https://issuer.example",
        }
    )
    _install_jwks(monkeypatch, mod, jwk)
    token = _mint(private_pem)

    r = _client(mod).get("/", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


def test_oauth2_rejects_wrong_audience(reload_middleware, rsa_keypair, monkeypatch):
    private_pem, jwk = rsa_keypair
    mod = reload_middleware(
        {
            "MCP_AUTH_MODE": "oauth2",
            "JWKS_URI": "https://issuer.example/jwks",
            "AUDIENCE": "mcp-test",
            "ISSUER": "https://issuer.example",
        }
    )
    _install_jwks(monkeypatch, mod, jwk)
    token = _mint(private_pem, aud="other-audience")

    r = _client(mod).get("/", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_oauth2_rejects_wrong_issuer(reload_middleware, rsa_keypair, monkeypatch):
    private_pem, jwk = rsa_keypair
    mod = reload_middleware(
        {
            "MCP_AUTH_MODE": "oauth2",
            "JWKS_URI": "https://issuer.example/jwks",
            "AUDIENCE": "mcp-test",
            "ISSUER": "https://issuer.example",
        }
    )
    _install_jwks(monkeypatch, mod, jwk)
    token = _mint(private_pem, iss="https://attacker.example")

    r = _client(mod).get("/", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_oauth2_rejects_expired_token(reload_middleware, rsa_keypair, monkeypatch):
    private_pem, jwk = rsa_keypair
    mod = reload_middleware(
        {
            "MCP_AUTH_MODE": "oauth2",
            "JWKS_URI": "https://issuer.example/jwks",
            "AUDIENCE": "mcp-test",
            "ISSUER": "https://issuer.example",
        }
    )
    _install_jwks(monkeypatch, mod, jwk)
    # exp_offset must clear the 10s leeway in middleware.CLOCK_SKEW_LEEWAY
    token = _mint(private_pem, exp_offset=-60)

    r = _client(mod).get("/", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_oauth2_rejects_unknown_kid(reload_middleware, rsa_keypair, monkeypatch):
    private_pem, jwk = rsa_keypair
    mod = reload_middleware(
        {
            "MCP_AUTH_MODE": "oauth2",
            "JWKS_URI": "https://issuer.example/jwks",
            "AUDIENCE": "mcp-test",
            "ISSUER": "https://issuer.example",
        }
    )
    _install_jwks(monkeypatch, mod, jwk)
    token = _mint(private_pem, kid="nope")

    r = _client(mod).get("/", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_oauth2_rejects_alg_none_attack(reload_middleware, rsa_keypair, monkeypatch):
    """Codeguard: never trust ``alg=none`` tokens."""
    _, jwk = rsa_keypair
    mod = reload_middleware(
        {
            "MCP_AUTH_MODE": "oauth2",
            "JWKS_URI": "https://issuer.example/jwks",
            "AUDIENCE": "mcp-test",
            "ISSUER": "https://issuer.example",
        }
    )
    _install_jwks(monkeypatch, mod, jwk)
    # Hand-craft an unsigned token with alg=none.
    token = jwt.encode(
        {
            "iss": "https://issuer.example",
            "aud": "mcp-test",
            "exp": int(time.time()) + 300,
        },
        key="",
        algorithm="none",
        headers={"kid": "test-kid-1"},
    )
    r = _client(mod).get("/", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_oauth2_enforces_client_id_allowlist(
    reload_middleware, rsa_keypair, monkeypatch
):
    private_pem, jwk = rsa_keypair
    mod = reload_middleware(
        {
            "MCP_AUTH_MODE": "oauth2",
            "JWKS_URI": "https://issuer.example/jwks",
            "AUDIENCE": "mcp-test",
            "ISSUER": "https://issuer.example",
            "OAUTH2_CLIENT_ID": "trusted-app,internal-svc",
        }
    )
    _install_jwks(monkeypatch, mod, jwk)

    bad = _mint(private_pem, extra={"cid": "rogue-app"})
    assert (
        _client(mod).get("/", headers={"Authorization": f"Bearer {bad}"}).status_code
        == 401
    )

    good = _mint(private_pem, extra={"cid": "trusted-app"})
    assert (
        _client(mod).get("/", headers={"Authorization": f"Bearer {good}"}).status_code
        == 200
    )


def test_oauth2_rejects_missing_client_id_when_allowlist_configured(
    reload_middleware, rsa_keypair, monkeypatch
):
    private_pem, jwk = rsa_keypair
    mod = reload_middleware(
        {
            "MCP_AUTH_MODE": "oauth2",
            "JWKS_URI": "https://issuer.example/jwks",
            "AUDIENCE": "mcp-test",
            "ISSUER": "https://issuer.example",
            "OAUTH2_CLIENT_ID": "trusted-app",
        }
    )
    _install_jwks(monkeypatch, mod, jwk)
    token = _mint(private_pem)

    response = _client(mod).get(
        "/", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 401


def test_oauth2_requires_jwks_uri_at_import(reload_middleware):
    with pytest.raises(ValueError, match="JWKS_URI"):
        reload_middleware({"MCP_AUTH_MODE": "oauth2", "AUDIENCE": "x", "ISSUER": "y"})


def test_oauth2_requires_audience_at_import(reload_middleware):
    with pytest.raises(ValueError, match="AUDIENCE"):
        reload_middleware(
            {"MCP_AUTH_MODE": "oauth2", "JWKS_URI": "https://x", "ISSUER": "y"}
        )


def test_oauth2_requires_issuer_at_import(reload_middleware):
    with pytest.raises(ValueError, match="ISSUER"):
        reload_middleware(
            {"MCP_AUTH_MODE": "oauth2", "JWKS_URI": "https://x", "AUDIENCE": "y"}
        )
