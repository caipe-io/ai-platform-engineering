"""Authentication for caller-owned scheduler operations."""

from __future__ import annotations

from dataclasses import dataclass

import jwt
from fastapi import HTTPException
from jwt import PyJWKClient

from caipe_scheduler.config import Settings


@dataclass(frozen=True)
class CallerIdentity:
  sub: str
  email: str
  token: str


_jwks_clients: dict[str, PyJWKClient] = {}


def _jwks_client(url: str) -> PyJWKClient:
  client = _jwks_clients.get(url)
  if client is None:
    client = PyJWKClient(url, cache_keys=True)
    _jwks_clients[url] = client
  return client


def authenticate_caller(authorization: str | None, settings: Settings) -> CallerIdentity:
  """Validate a bearer and derive the immutable schedule owner."""
  if not settings.jwt_jwks_url or not settings.jwt_issuer or not settings.jwt_audiences:
    raise HTTPException(503, "Scheduler caller authentication is not configured.")
  if not authorization or not authorization.lower().startswith("bearer "):
    raise HTTPException(401, "Invalid or missing Authorization bearer token.")

  token = authorization[7:].strip()
  if not token:
    raise HTTPException(401, "Invalid or missing Authorization bearer token.")

  try:
    signing_key = _jwks_client(settings.jwt_jwks_url).get_signing_key_from_jwt(token)
    claims = jwt.decode(
      token,
      signing_key.key,
      algorithms=list(settings.jwt_algorithms),
      audience=list(settings.jwt_audiences),
      issuer=settings.jwt_issuer,
      options={"require": ["exp", "iat", "sub"]},
    )
  except jwt.PyJWKClientConnectionError as exc:
    raise HTTPException(503, "Scheduler caller authentication is unavailable.") from exc
  except jwt.PyJWTError as exc:
    raise HTTPException(401, "Invalid or expired caller token.") from exc
  except Exception as exc:
    raise HTTPException(503, "Scheduler caller authentication is unavailable.") from exc

  sub = claims.get("sub")
  email = claims.get("email") or claims.get("preferred_username")
  if not isinstance(sub, str) or not sub.strip():
    raise HTTPException(401, "Caller token has no subject.")
  if not isinstance(email, str) or not email.strip():
    raise HTTPException(401, "Caller token has no email or username.")
  return CallerIdentity(sub=sub.strip(), email=email.strip().lower(), token=token)
