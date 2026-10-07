# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
OAuth2 Client Credentials authentication for backend API requests.

Generic OAuth2 client credentials flow that works with any OIDC provider
(Okta, Keycloak, Auth0, Azure AD, etc.). Obtains Bearer tokens for
machine-to-machine authentication with the dynamic agents backend.
"""

import os
import time
import requests
from typing import Optional
from loguru import logger
from dataclasses import dataclass


@dataclass
class TokenInfo:
  """Container for access token and expiry info."""

  access_token: str
  expires_at: float  # Unix timestamp


class OAuth2ClientCredentials:
  """
  OAuth2 Client Credentials authentication client.

  Features:
  - Fetches access tokens using client_id and client_secret
  - Caches tokens and refreshes before expiry (60s buffer)
  - Hard failure on errors — raises immediately
  - Works with any OIDC provider
  """

  def __init__(
    self,
    token_url: str,
    client_id: str,
    client_secret: str,
    scope: Optional[str] = None,
    audience: Optional[str] = None,
  ):
    self.token_url = token_url
    self.client_id = client_id
    self.client_secret = client_secret
    self.scope = scope
    self.audience = audience
    self._cached_token: Optional[TokenInfo] = None

    logger.info(f"OAuth2 client credentials initialized (token_url={token_url}, client_id={client_id[:8]}...)")

  @classmethod
  def from_env(cls) -> "OAuth2ClientCredentials":
    """
    Create from environment variables.

    Uses SLACK_INTEGRATION_AUTH_* prefix with fallback to generic names:
    - SLACK_INTEGRATION_AUTH_TOKEN_URL / OAUTH2_TOKEN_URL
    - SLACK_INTEGRATION_AUTH_CLIENT_ID / OAUTH2_CLIENT_ID
    - SLACK_INTEGRATION_AUTH_CLIENT_SECRET / OAUTH2_CLIENT_SECRET
    - SLACK_INTEGRATION_AUTH_SCOPE / OAUTH2_SCOPE (optional)
    - SLACK_INTEGRATION_AUTH_AUDIENCE / OAUTH2_AUDIENCE (optional)

    Raises:
        RuntimeError: If required env vars are missing.
    """

    def env(primary, fallback):
      return os.environ.get(primary, os.environ.get(fallback))

    token_url = env("SLACK_INTEGRATION_AUTH_TOKEN_URL", "OAUTH2_TOKEN_URL")
    client_id = env("SLACK_INTEGRATION_AUTH_CLIENT_ID", "OAUTH2_CLIENT_ID")
    client_secret = env("SLACK_INTEGRATION_AUTH_CLIENT_SECRET", "OAUTH2_CLIENT_SECRET")
    scope = env("SLACK_INTEGRATION_AUTH_SCOPE", "OAUTH2_SCOPE")
    audience = env("SLACK_INTEGRATION_AUTH_AUDIENCE", "OAUTH2_AUDIENCE")

    missing = []
    if not token_url:
      missing.append("SLACK_INTEGRATION_AUTH_TOKEN_URL")
    if not client_id:
      missing.append("SLACK_INTEGRATION_AUTH_CLIENT_ID")
    if not client_secret:
      missing.append("SLACK_INTEGRATION_AUTH_CLIENT_SECRET")

    if missing:
      raise RuntimeError(f"Missing required OAuth2 env vars: {', '.join(missing)}")

    return cls(
      token_url=token_url,
      client_id=client_id,
      client_secret=client_secret,
      scope=scope,
      audience=audience,
    )

  def get_access_token(self) -> str:
    """
    Get a valid access token, using cache if available.

    Returns:
        Access token string.

    Raises:
        RuntimeError: If token fetch fails.
    """
    if self._cached_token and time.time() < (self._cached_token.expires_at - 60):
      return self._cached_token.access_token

    logger.info("Fetching new OAuth2 access token")
    return self._fetch_token()

  def _fetch_token(self) -> str:
    """Fetch a new access token using client credentials flow."""
    payload = {
      "grant_type": "client_credentials",
      "client_id": self.client_id,
      "client_secret": self.client_secret,
    }

    if self.scope:
      payload["scope"] = self.scope
    if self.audience:
      payload["audience"] = self.audience

    response = requests.post(
      self.token_url,
      data=payload,
      headers={"Content-Type": "application/x-www-form-urlencoded"},
      timeout=10,
    )

    if not response.ok:
      raise RuntimeError(f"OAuth2 token fetch failed: HTTP {response.status_code} - {response.text}")

    token_data = response.json()
    access_token = token_data.get("access_token")
    expires_in = token_data.get("expires_in", 3600)

    if not access_token:
      raise RuntimeError(f"No access_token in OAuth2 response: {token_data}")

    self._cached_token = TokenInfo(
      access_token=access_token,
      expires_at=time.time() + expires_in,
    )

    logger.info(f"OAuth2 access token obtained (expires in {expires_in}s)")
    return access_token

  def clear_cache(self):
    """Clear cached token."""
    self._cached_token = None
