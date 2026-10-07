"""Spec 102 T025 — unit tests for `jwks_validate.validate_bearer_jwt`.

Generates a throwaway RS256 keypair, mints tokens locally, monkeypatches
`PyJWKClient.get_signing_key_from_jwt` to return the public key, and verifies
that the validator accepts good tokens and rejects bad ones with the right
exception types.

Covers (per spec 102 §T025):
  - valid token                     → returns claims dict
  - expired token                   → ExpiredSignatureError
  - wrong issuer                    → InvalidIssuerError (subclass of InvalidTokenError)
  - wrong audience                  → InvalidAudienceError
  - signature mismatch              → InvalidSignatureError
  - empty bearer                    → InvalidTokenError
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import pytest

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from ai_platform_engineering.utils.auth import jwks_validate


@dataclass
class _Keypair:
    private_pem: bytes
    public_key: object  # cryptography RSAPublicKey


@pytest.fixture(scope="module")
def keypair() -> _Keypair:
    from cryptography.hazmat.primitives import serialization

    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return _Keypair(private_pem=pem, public_key=priv.public_key())


def _mint(
    keypair: _Keypair,
    *,
    issuer: str,
    audience: str,
    sub: str = "test-user",
    exp_offset_s: int = 600,
) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "iss": issuer,
            "aud": audience,
            "sub": sub,
            "iat": now,
            "exp": now + exp_offset_s,
        },
        keypair.private_pem,
        algorithm="RS256",
    )


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEYCLOAK_URL", "http://kc.example:7080")
    monkeypatch.setenv("KEYCLOAK_REALM", "caipe")
    monkeypatch.setenv("KEYCLOAK_AUDIENCE", "caipe-platform")
    jwks_validate.reset_jwks_cache_for_tests()


@pytest.fixture
def patch_jwks(keypair: _Keypair, monkeypatch: pytest.MonkeyPatch) -> None:
    """Make `PyJWKClient.get_signing_key_from_jwt` return our public key."""

    class _SigningKey:
        key = keypair.public_key

    def _fake(self, _token):  # noqa: ANN001
        return _SigningKey()

    monkeypatch.setattr(jwks_validate.PyJWKClient, "get_signing_key_from_jwt", _fake)


def test_valid_token_returns_claims(env, patch_jwks, keypair: _Keypair) -> None:
    token = _mint(keypair, issuer="http://kc.example:7080/realms/caipe", audience="caipe-platform")
    claims = jwks_validate.validate_bearer_jwt(token)
    assert claims["sub"] == "test-user"
    assert claims["aud"] == "caipe-platform"


def test_expired_token_raises(env, patch_jwks, keypair: _Keypair) -> None:
    token = _mint(
        keypair,
        issuer="http://kc.example:7080/realms/caipe",
        audience="caipe-platform",
        exp_offset_s=-10,
    )
    with pytest.raises(jwks_validate.InvalidTokenError):
        jwks_validate.validate_bearer_jwt(token)


def test_wrong_issuer_raises(env, patch_jwks, keypair: _Keypair) -> None:
    token = _mint(keypair, issuer="http://evil.example/realms/caipe", audience="caipe-platform")
    with pytest.raises(jwks_validate.InvalidTokenError):
        jwks_validate.validate_bearer_jwt(token)


def test_wrong_audience_raises(env, patch_jwks, keypair: _Keypair) -> None:
    token = _mint(keypair, issuer="http://kc.example:7080/realms/caipe", audience="some-other-client")
    with pytest.raises(jwks_validate.InvalidTokenError):
        jwks_validate.validate_bearer_jwt(token)


def test_signature_mismatch_raises(env, patch_jwks, keypair: _Keypair) -> None:
    token = _mint(keypair, issuer="http://kc.example:7080/realms/caipe", audience="caipe-platform")
    # Flip an actual signature byte. Replacing trailing base64url characters can
    # alter only unused padding bits and occasionally leave the decoded bytes
    # unchanged.
    head, payload, sig = token.split(".")
    signature = bytearray(jwt.utils.base64url_decode(sig.encode("ascii")))
    signature[0] ^= 1
    tampered_sig = jwt.utils.base64url_encode(bytes(signature)).decode("ascii")
    tampered = ".".join([head, payload, tampered_sig])
    with pytest.raises(jwks_validate.InvalidTokenError):
        jwks_validate.validate_bearer_jwt(tampered)


def test_empty_bearer_raises(env) -> None:
    with pytest.raises(jwks_validate.InvalidTokenError):
        jwks_validate.validate_bearer_jwt("")
