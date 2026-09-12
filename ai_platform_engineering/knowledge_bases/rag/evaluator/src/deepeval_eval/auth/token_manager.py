from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests
from pydantic import SecretStr

from deepeval_eval.auth.obo_exchange import exchange_token_for_user, is_obo_enabled

logger = logging.getLogger(__name__)

DEFAULT_KEYCLOAK_TOKEN_URL = (
    "http://localhost:7080/realms/caipe/protocol/openid-connect/token"
)
TOKEN_EXPIRY_BUFFER_SECONDS = 30
DEFAULT_TOKEN_TIMEOUT_SECONDS: float = 15.0


class OidcTokenManager:
    """Manages OIDC token lifecycle, proactive TTL refresh, and reactive renewal.

    Supports:
    1. Static JWT tokens (e.g. from environment or UI session).
    2. Machine-to-Machine (M2M) service account OAuth2 client credentials grant.
    3. RFC 8693 On-Behalf-Of (OBO) token exchange for a designated user subject.
    """

    def __init__(
        self,
        token_url: str | None = None,
        client_id: str | None = None,
        client_secret: str | SecretStr | None = None,
        static_token: str | SecretStr | None = None,
        user_subject: str | None = None,
        verify: bool | str = True,
        timeout: float = DEFAULT_TOKEN_TIMEOUT_SECONDS,
    ) -> None:
        self.verify = verify
        self.timeout = timeout
        self.user_subject = user_subject

        # Resolve client credentials from params or environment
        if user_subject and is_obo_enabled():
            self.client_id = (
                os.getenv("EVALUATOR_OBO_CLIENT_ID")
                or client_id
                or os.getenv("EVALUATOR_OIDC_CLIENT_ID")
                or os.getenv("CAIPE_SA_CLIENT_ID")
                or os.getenv("CAIPE_CLIENT_ID")
                or None
            )
        else:
            self.client_id = (
                client_id
                or os.getenv("EVALUATOR_OIDC_CLIENT_ID")
                or os.getenv("CAIPE_SA_CLIENT_ID")
                or os.getenv("CAIPE_CLIENT_ID")
                or None
            )

        secret_val = (
            client_secret.get_secret_value()
            if isinstance(client_secret, SecretStr)
            else client_secret
        )
        if user_subject and is_obo_enabled():
            self.client_secret = (
                os.getenv("EVALUATOR_OBO_CLIENT_SECRET")
                or secret_val
                or os.getenv("EVALUATOR_OIDC_CLIENT_SECRET")
                or os.getenv("CAIPE_SA_CLIENT_SECRET")
                or os.getenv("CAIPE_CLIENT_SECRET")
                or None
            )
        else:
            self.client_secret = (
                secret_val
                or os.getenv("EVALUATOR_OIDC_CLIENT_SECRET")
                or os.getenv("CAIPE_SA_CLIENT_SECRET")
                or os.getenv("CAIPE_CLIENT_SECRET")
                or None
            )

        # Resolve token URL
        issuer = os.getenv("EVALUATOR_OIDC_ISSUER")
        issuer_token_url = (
            f"{issuer.rstrip('/')}/protocol/openid-connect/token" if issuer else None
        )
        self.token_url = (
            (
                os.getenv("EVALUATOR_OBO_TOKEN_URL")
                if user_subject and is_obo_enabled()
                else None
            )
            or token_url
            or os.getenv("EVALUATOR_OIDC_TOKEN_URL")
            or os.getenv("CAIPE_SA_TOKEN_URL")
            or issuer_token_url
            or os.getenv("KEYCLOAK_URL")
            or (
                DEFAULT_KEYCLOAK_TOKEN_URL
                if self.client_id and self.client_secret
                else None
            )
        )

        # Resolve initial static token only if explicitly provided or if client credentials are not configured
        raw_static = (
            static_token.get_secret_value()
            if isinstance(static_token, SecretStr)
            else static_token
        )
        if raw_static:
            self.static_token = raw_static
        elif not self.has_client_credentials and not self.user_subject:
            self.static_token = (
                os.getenv("CAIPE_OIDC_TOKEN")
                or os.getenv("BEARER_TOKEN")
                or os.getenv("DEEPEVAL_API_KEY")
                or None
            )
        else:
            self.static_token = None

        self._cached_token: str | None = None
        self._token_expiry: float = 0.0

        # If static token is provided, initialize cache with default buffer window
        if self.static_token:
            self._cached_token = self.static_token
            # Static tokens have an unknown lifespan; set 5-minute fallback before M2M fallback check
            self._token_expiry = time.time() + 300.0

    @classmethod
    def for_user_subject(
        cls,
        subject: str,
        token_url: str | None = None,
        client_id: str | None = None,
        client_secret: str | SecretStr | None = None,
        verify: bool | str = True,
        timeout: float = DEFAULT_TOKEN_TIMEOUT_SECONDS,
    ) -> OidcTokenManager:
        """Create a token manager dedicated to minting and renewing OBO tokens for a given user subject."""
        return cls(
            token_url=token_url,
            client_id=client_id,
            client_secret=client_secret,
            user_subject=subject,
            verify=verify,
            timeout=timeout,
        )

    @property
    def has_client_credentials(self) -> bool:
        """Return True if M2M or OBO client credentials are configured."""
        return bool(self.client_id and self.client_secret and self.token_url)

    def fetch_fresh_token(self) -> str:
        """Fetch a fresh access token using OBO token exchange or client credentials."""
        if self.user_subject and is_obo_enabled():
            verify_flag = self.verify if isinstance(self.verify, bool) else True
            token = exchange_token_for_user(
                subject=self.user_subject,
                client_id=self.client_id,
                client_secret=self.client_secret,
                token_url=self.token_url,
                verify_ssl=verify_flag,
                timeout=self.timeout,
            )
            self._cached_token = token
            self._token_expiry = time.time() + 270.0
            return token

        if not self.has_client_credentials:
            raise RuntimeError(
                "Cannot fetch fresh OIDC token: client_id and client_secret must be configured."
            )

        payload = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "grant_type": "client_credentials",
        }

        logger.info("Fetching fresh OIDC token from Keycloak: %s", self.token_url)
        try:
            resp = requests.post(
                self.token_url,
                data=payload,
                verify=self.verify,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()

            token = data.get("access_token")
            if not token:
                raise RuntimeError(
                    f"Token endpoint response did not contain access_token: {data}"
                )

            expires_in = int(data.get("expires_in", 300))
            self._cached_token = token
            self._token_expiry = time.time() + max(
                0, expires_in - TOKEN_EXPIRY_BUFFER_SECONDS
            )
            logger.info("OIDC token acquired successfully. Valid for %ds.", expires_in)
            return token
        except Exception as exc:
            logger.exception("Failed to obtain OIDC token via client_credentials.")
            raise RuntimeError(f"Failed to fetch OIDC token: {exc}") from exc

    def get_token(self) -> str | None:
        """Retrieve a valid token, refreshing proactively if expired and credentials exist."""
        now = time.time()

        # If we have client credentials and the cached token is expired or absent, fetch fresh
        if self.has_client_credentials:
            if not self._cached_token or now >= self._token_expiry:
                return self.fetch_fresh_token()
            return self._cached_token

        # If we have a cached static token, return it
        if self._cached_token:
            return self._cached_token

        # Fallback to checking environment dynamically
        env_token = (
            os.getenv("CAIPE_OIDC_TOKEN")
            or os.getenv("BEARER_TOKEN")
            or os.getenv("DEEPEVAL_API_KEY")
        )
        if env_token:
            self._cached_token = env_token
            return env_token

        return None

    def force_refresh(self) -> str | None:
        """Invalidate cached token and force-fetch a fresh token if client credentials exist."""
        self._cached_token = None
        self._token_expiry = 0.0

        if self.has_client_credentials:
            return self.fetch_fresh_token()

        return self.get_token()

    def get_auth_headers(self) -> dict[str, str]:
        """Return Authorization header dictionary if token is available."""
        token = self.get_token()
        if token:
            return {"Authorization": f"Bearer {token}"}
        return {}
