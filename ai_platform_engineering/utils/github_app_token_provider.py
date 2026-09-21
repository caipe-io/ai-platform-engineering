# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
GitHub App Token Provider - Automatic installation token generation and refresh.

Provides a centralized token provider that supports two authentication modes:

1. **GitHub App mode** (recommended for production/CI):
   - Uses GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID
   - Generates short-lived installation tokens (60 min) via JWT exchange
   - Automatically refreshes tokens before expiry (5 min buffer)
   - No manual PAT rotation needed

2. **PAT mode** (fallback for development):
   - Uses GITHUB_PERSONAL_ACCESS_TOKEN, GH_TOKEN, or GITHUB_TOKEN
   - No auto-refresh (manual rotation required)

Usage:
    from ai_platform_engineering.utils.github_app_token_provider import get_github_token

    # Returns a valid token (auto-refreshed if using GitHub App mode)
    token = get_github_token()

Environment Variables (GitHub App mode):
    GITHUB_APP_ID:                GitHub App ID (from app settings page)
    GITHUB_APP_PRIVATE_KEY:       PEM private key contents (or base64-encoded)
    GITHUB_APP_PRIVATE_KEY_PATH:  Path to PEM private key file (alternative)
    GITHUB_APP_INSTALLATION_ID:   Installation ID for the org/repo

Environment Variables (PAT mode - fallback):
    GITHUB_PERSONAL_ACCESS_TOKEN: Classic or fine-grained PAT
    GH_TOKEN:                     gh CLI-compatible PAT variable
    GITHUB_TOKEN:                 Alternative PAT variable
"""

import base64
import logging
import os
import threading
import time
from typing import Optional

import httpx
import jwt

logger = logging.getLogger(__name__)

# Token refresh buffer - refresh 5 minutes before actual expiry
_REFRESH_BUFFER_SECONDS = 300

# GitHub API base URL (supports GHES via GITHUB_HOST)
_GITHUB_API_URL = os.getenv("GITHUB_API_URL", "https://api.github.com")


class GitHubAppTokenProvider:
    """
    Thread-safe GitHub App installation token provider with auto-refresh.

    Generates a JWT from the App's private key, exchanges it for an
    installation access token, and transparently refreshes before expiry.
    """

    def __init__(
        self,
        app_id: str,
        private_key: str,
        installation_id: str,
        api_url: str = _GITHUB_API_URL,
    ):
        """
        Initialize the GitHub App token provider.

        Args:
            app_id: GitHub App ID
            private_key: PEM-formatted private key string
            installation_id: Installation ID for the target org/repo
            api_url: GitHub API base URL (default: https://api.github.com)
        """
        self.app_id = app_id
        self.private_key = private_key
        self.installation_id = installation_id
        self.api_url = api_url.rstrip("/")

        self._token: Optional[str] = None
        self._expires_at: float = 0
        self._lock = threading.Lock()

        logger.info(
            "GitHub App token provider initialized "
            f"(app_id={app_id}, installation_id={installation_id})"
        )

    def _generate_jwt(self) -> str:
        """
        Generate a short-lived JWT for the GitHub App.

        The JWT is used to authenticate as the App itself (not as an installation)
        and is valid for up to 10 minutes.

        Returns:
            Encoded JWT string
        """
        now = int(time.time())
        payload = {
            "iat": now - 60,       # Issued at (60s in the past for clock skew)
            "exp": now + (10 * 60),  # Expires in 10 minutes
            "iss": self.app_id,     # Issuer = App ID
        }
        encoded = jwt.encode(payload, self.private_key, algorithm="RS256")
        logger.debug("Generated GitHub App JWT (valid for 10 min)")
        return encoded

    def _request_installation_token(self) -> tuple[str, float]:
        """
        Exchange JWT for an installation access token.

        Returns:
            Tuple of (token, expires_at_timestamp)

        Raises:
            httpx.HTTPStatusError: If the GitHub API returns an error
            Exception: For network or other failures
        """
        app_jwt = self._generate_jwt()

        url = (
            f"{self.api_url}/app/installations/"
            f"{self.installation_id}/access_tokens"
        )

        with httpx.Client(timeout=30) as client:
            response = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {app_jwt}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            response.raise_for_status()

        data = response.json()
        token = data["token"]

        # Parse expiry - GitHub returns ISO 8601 format
        # e.g., "2024-01-01T01:00:00Z"
        expires_at_str = data.get("expires_at", "")
        if expires_at_str:
            from datetime import datetime
            expires_at = datetime.fromisoformat(
                expires_at_str.replace("Z", "+00:00")
            ).timestamp()
        else:
            # Fallback: assume 60 minutes from now
            expires_at = time.time() + 3600

        logger.info(
            f"GitHub App installation token obtained "
            f"(expires in {int(expires_at - time.time())}s)"
        )
        return token, expires_at

    def get_token_health(self) -> dict:
        """
        Get health information about the current token state.

        Returns:
            Dictionary with token health details:
            - auth_mode: "github_app"
            - has_token: bool
            - expires_at_utc: ISO 8601 timestamp or None
            - expires_in_seconds: int or None
            - status: "healthy" | "expiring_soon" | "expired" | "no_token"
        """
        now = time.time()
        if not self._token:
            return {
                "auth_mode": "github_app",
                "has_token": False,
                "expires_at_utc": None,
                "expires_in_seconds": None,
                "status": "no_token",
            }

        expires_in = int(self._expires_at - now)
        from datetime import datetime, timezone
        expires_at_utc = datetime.fromtimestamp(
            self._expires_at, tz=timezone.utc
        ).isoformat()

        if expires_in <= 0:
            status = "expired"
        elif expires_in <= _REFRESH_BUFFER_SECONDS:
            status = "expiring_soon"
        else:
            status = "healthy"

        return {
            "auth_mode": "github_app",
            "has_token": True,
            "expires_at_utc": expires_at_utc,
            "expires_in_seconds": max(expires_in, 0),
            "status": status,
        }

    def get_token(self) -> str:
        """
        Get a valid installation access token, refreshing if needed.

        Thread-safe: multiple concurrent callers will wait for a single
        refresh operation.

        Returns:
            Valid GitHub installation access token

        Raises:
            Exception: If token generation fails
        """
        # Fast path: token is still valid
        if self._token and time.time() < (self._expires_at - _REFRESH_BUFFER_SECONDS):
            return self._token

        # Slow path: need to refresh
        with self._lock:
            # Double-check after acquiring lock (another thread may have refreshed)
            if self._token and time.time() < (self._expires_at - _REFRESH_BUFFER_SECONDS):
                return self._token

            logger.info("Refreshing GitHub App installation token...")
            try:
                self._token, self._expires_at = self._request_installation_token()
            except httpx.HTTPStatusError as e:
                logger.error(
                    f"Failed to obtain GitHub App installation token: "
                    f"{e.response.status_code} {e.response.text}"
                )
                raise
            except Exception as e:
                logger.error(f"Failed to obtain GitHub App installation token: {e}")
                raise

        return self._token


# =============================================================================
# Module-level singleton and convenience functions
# =============================================================================

_provider: Optional[GitHubAppTokenProvider] = None
_provider_init_lock = threading.Lock()


def _load_private_key() -> Optional[str]:
    """
    Load the GitHub App private key from environment.

    Supports three formats:
    1. GITHUB_APP_PRIVATE_KEY_PATH: Path to a PEM file
    2. GITHUB_APP_PRIVATE_KEY: Raw PEM string (may have \\n literals)
    3. GITHUB_APP_PRIVATE_KEY: Base64-encoded PEM string

    Returns:
        PEM private key string, or None if not configured
    """
    # Option 1: File path
    key_path = os.getenv("GITHUB_APP_PRIVATE_KEY_PATH")
    if key_path:
        try:
            with open(key_path, "r") as f:
                key = f.read().strip()
            logger.info(f"Loaded GitHub App private key from file: {key_path}")
            return key
        except (FileNotFoundError, PermissionError) as e:
            logger.error(f"Failed to read private key file '{key_path}': {e}")
            return None

    # Option 2: Environment variable (raw PEM or base64)
    key_env = os.getenv("GITHUB_APP_PRIVATE_KEY")
    if not key_env:
        return None

    # Handle escaped newlines from env vars / docker-compose
    key_env = key_env.replace("\\n", "\n")

    # Check if it looks like PEM
    if key_env.strip().startswith("-----BEGIN"):
        logger.info("Loaded GitHub App private key from GITHUB_APP_PRIVATE_KEY env var")
        return key_env.strip()

    # Try base64 decode
    try:
        decoded = base64.b64decode(key_env).decode("utf-8").strip()
        if decoded.startswith("-----BEGIN"):
            logger.info(
                "Loaded GitHub App private key from GITHUB_APP_PRIVATE_KEY "
                "(base64-decoded)"
            )
            return decoded
    except Exception:
        pass

    logger.error(
        "GITHUB_APP_PRIVATE_KEY is set but doesn't appear to be a valid PEM key "
        "(expected PEM format or base64-encoded PEM)"
    )
    return None


def _get_provider() -> Optional[GitHubAppTokenProvider]:
    """
    Get or create the singleton GitHubAppTokenProvider.

    Returns:
        GitHubAppTokenProvider if GitHub App env vars are configured, None otherwise
    """
    global _provider

    if _provider is not None:
        return _provider

    with _provider_init_lock:
        # Double-check after lock
        if _provider is not None:
            return _provider

        app_id = os.getenv("GITHUB_APP_ID")
        installation_id = os.getenv("GITHUB_APP_INSTALLATION_ID")
        private_key = _load_private_key()

        if app_id and installation_id and private_key:
            _provider = GitHubAppTokenProvider(
                app_id=app_id,
                private_key=private_key,
                installation_id=installation_id,
            )
            return _provider

        # Not all GitHub App vars are set
        if any([app_id, installation_id, private_key]):
            missing = []
            if not app_id:
                missing.append("GITHUB_APP_ID")
            if not installation_id:
                missing.append("GITHUB_APP_INSTALLATION_ID")
            if not private_key:
                missing.append("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH")
            logger.warning(
                f"Partial GitHub App configuration detected. Missing: {', '.join(missing)}. "
                "Falling back to GITHUB_PERSONAL_ACCESS_TOKEN."
            )

        return None


def get_github_token() -> Optional[str]:
    """
    Get a valid GitHub token, using the best available method.

    Priority:
    1. GitHub App installation token (auto-refreshing, if configured)
    2. GITHUB_PERSONAL_ACCESS_TOKEN env var
    3. GH_TOKEN env var
    4. GITHUB_TOKEN env var
    5. None

    Returns:
        Valid GitHub token string, or None if no auth is configured

    Example:
        token = get_github_token()
        if token:
            headers = {"Authorization": f"Bearer {token}"}
    """
    # Try GitHub App first
    provider = _get_provider()
    if provider:
        try:
            return provider.get_token()
        except Exception as e:
            logger.error(
                f"GitHub App token generation failed, falling back to PAT: {e}"
            )

    # Fallback to PAT
    token = (
        os.getenv("GITHUB_PERSONAL_ACCESS_TOKEN")
        or os.getenv("GH_TOKEN")
        or os.getenv("GITHUB_TOKEN")
    )
    if token:
        logger.debug("Using GitHub PAT for authentication")
    return token


def is_github_app_mode() -> bool:
    """
    Check if GitHub App authentication is configured and active.

    Returns:
        True if GitHub App mode is active, False if using PAT fallback
    """
    return _get_provider() is not None


def get_token_health() -> dict:
    """
    Get health information about the current GitHub authentication state.

    Returns:
        Dictionary with auth health details including mode, token status,
        and expiry information (for GitHub App mode).

    Example response (GitHub App mode):
        {
            "auth_mode": "github_app",
            "has_token": True,
            "expires_at_utc": "2026-02-10T01:30:00+00:00",
            "expires_in_seconds": 3245,
            "status": "healthy"
        }

    Example response (PAT mode):
        {
            "auth_mode": "pat",
            "has_token": True,
            "status": "healthy"
        }

    Example response (no auth):
        {
            "auth_mode": "none",
            "has_token": False,
            "status": "no_credentials"
        }
    """
    provider = _get_provider()
    if provider:
        return provider.get_token_health()

    # PAT fallback
    token = (
        os.getenv("GITHUB_PERSONAL_ACCESS_TOKEN")
        or os.getenv("GH_TOKEN")
        or os.getenv("GITHUB_TOKEN")
    )
    if token:
        return {
            "auth_mode": "pat",
            "has_token": True,
            "status": "healthy",
        }

    return {
        "auth_mode": "none",
        "has_token": False,
        "status": "no_credentials",
    }
