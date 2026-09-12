from __future__ import annotations

import logging
import os
from typing import Any

import requests
from pydantic import BaseModel, ConfigDict, Field, SecretStr

logger = logging.getLogger(__name__)

DEFAULT_OBO_AUDIENCE = "caipe-platform"
DEFAULT_TOKEN_TIMEOUT_SECONDS: float = 15.0


class OboExchangeError(Exception):
    """Raised when an RFC 8693 token exchange operation fails."""


class OboExchangeConfig(BaseModel):
    """Configuration for RFC 8693 On-Behalf-Of (OBO) token exchange."""

    model_config = ConfigDict(extra="ignore")

    enabled: bool = Field(default=False)
    client_id: str | None = Field(default=None)
    client_secret: SecretStr | None = Field(default=None)
    token_url: str | None = Field(default=None)
    audience: str = Field(default=DEFAULT_OBO_AUDIENCE)
    verify_ssl: bool = Field(default=True)
    timeout: float = Field(default=DEFAULT_TOKEN_TIMEOUT_SECONDS)


def is_obo_enabled() -> bool:
    """Return True if EVALUATOR_OBO_ENABLED is explicitly enabled."""
    val = os.getenv("EVALUATOR_OBO_ENABLED", "").strip().lower()
    return val in ("1", "true", "yes", "on")


def _resolve_obo_config(
    client_id: str | None = None,
    client_secret: str | SecretStr | None = None,
    token_url: str | None = None,
    audience: str | None = None,
    verify_ssl: bool | None = None,
    timeout: float = DEFAULT_TOKEN_TIMEOUT_SECONDS,
) -> OboExchangeConfig:
    """Resolve OBO configuration from arguments and environment variables."""
    resolved_client_id = (
        client_id
        or os.getenv("EVALUATOR_OBO_CLIENT_ID")
        or os.getenv("EVALUATOR_OIDC_CLIENT_ID")
        or os.getenv("CAIPE_SA_CLIENT_ID")
        or None
    )

    secret_val: str | None = None
    if isinstance(client_secret, SecretStr):
        secret_val = client_secret.get_secret_value()
    elif isinstance(client_secret, str):
        secret_val = client_secret
    else:
        secret_val = (
            os.getenv("EVALUATOR_OBO_CLIENT_SECRET")
            or os.getenv("EVALUATOR_OIDC_CLIENT_SECRET")
            or os.getenv("CAIPE_SA_CLIENT_SECRET")
            or None
        )

    resolved_token_url = (
        token_url
        or os.getenv("EVALUATOR_OBO_TOKEN_URL")
        or os.getenv("EVALUATOR_OIDC_TOKEN_URL")
        or os.getenv("CAIPE_SA_TOKEN_URL")
        or (
            f"{os.getenv('EVALUATOR_OIDC_ISSUER', '').rstrip('/')}/protocol/openid-connect/token"
            if os.getenv("EVALUATOR_OIDC_ISSUER")
            else None
        )
        or (
            f"{os.getenv('KEYCLOAK_URL', '').rstrip('/')}/realms/caipe/protocol/openid-connect/token"
            if os.getenv("KEYCLOAK_URL")
            else None
        )
    )

    resolved_audience = (
        audience
        or os.getenv("EVALUATOR_OBO_AUDIENCE")
        or os.getenv("CAIPE_AUDIENCE")
        or DEFAULT_OBO_AUDIENCE
    )

    if verify_ssl is not None:
        resolved_verify = verify_ssl
    else:
        ssl_env = os.getenv("OIDC_VERIFY_SSL", "").strip().lower()
        resolved_verify = ssl_env not in ("0", "false", "no", "off")

    return OboExchangeConfig(
        enabled=is_obo_enabled(),
        client_id=resolved_client_id,
        client_secret=SecretStr(secret_val) if secret_val else None,
        token_url=resolved_token_url,
        audience=resolved_audience,
        verify_ssl=resolved_verify,
        timeout=timeout,
    )


def exchange_token_for_user(
    subject: str,
    audience: str | None = None,
    client_id: str | None = None,
    client_secret: str | SecretStr | None = None,
    token_url: str | None = None,
    verify_ssl: bool | None = None,
    timeout: float = DEFAULT_TOKEN_TIMEOUT_SECONDS,
) -> str:
    """Perform RFC 8693 OAuth 2.0 token exchange to obtain a delegated user bearer token.

    Args:
        subject: The unique identifier (sub) of the user on whose behalf the token is minted.
        audience: Target audience for the token (defaults to caipe-ui / caipe-platform).
        client_id: The OBO service account client ID.
        client_secret: The OBO service account client secret.
        token_url: The Keycloak OIDC token endpoint URL.
        verify_ssl: Whether to verify SSL certificates.
        timeout: Network timeout in seconds.

    Returns:
        The minted access token string.

    Raises:
        OboExchangeError: If OBO is disabled, configuration is incomplete, or the exchange request fails.
    """
    config = _resolve_obo_config(
        client_id=client_id,
        client_secret=client_secret,
        token_url=token_url,
        audience=audience,
        verify_ssl=verify_ssl,
        timeout=timeout,
    )

    if not config.enabled:
        raise OboExchangeError(
            "EVALUATOR_OBO_ENABLED is not enabled. Cannot perform user token exchange."
        )

    if not subject or not subject.strip():
        raise OboExchangeError("User subject cannot be empty for token exchange.")

    if not config.client_id or not config.client_secret or not config.token_url:
        raise OboExchangeError(
            "OBO credentials not configured: client_id, client_secret, and token_url are required."
        )

    payload: dict[str, str] = {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "requested_subject": subject.strip(),
        "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
        "client_id": config.client_id,
        "client_secret": config.client_secret.get_secret_value(),
        "audience": config.audience,
    }

    logger.info(
        "Performing RFC 8693 token exchange via client=%s for subject=%s (audience=%s)",
        config.client_id,
        subject,
        config.audience,
    )

    try:
        resp = requests.post(
            config.token_url,
            data=payload,
            verify=config.verify_ssl,
            timeout=config.timeout,
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        token = data.get("access_token")
        if not token or not isinstance(token, str):
            raise OboExchangeError(
                f"Token exchange response did not contain access_token: {data}"
            )
        logger.info(
            "OBO token exchange succeeded for subject=%s (expires_in=%ss)",
            subject,
            data.get("expires_in", "unknown"),
        )
        return token
    except OboExchangeError:
        raise
    except Exception as exc:
        logger.exception(
            "Failed RFC 8693 token exchange for subject=%s at %s",
            subject,
            config.token_url,
        )
        raise OboExchangeError(
            f"Failed RFC 8693 token exchange for subject '{subject}': {exc}"
        ) from exc
