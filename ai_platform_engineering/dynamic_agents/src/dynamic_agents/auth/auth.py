"""Signed gateway authentication context for Dynamic Agents.

All requests to DA are proxied through the Next.js gateway, which handles
OIDC authentication and session management.  The gateway injects a trusted
``X-User-Context`` header (base64-encoded JSON) containing pre-computed
authorization flags.

The JWT middleware validates the caller token independently. This module
also verifies the gateway signature before accepting display and role fields.
"""

import base64
import hashlib
import hmac
import json
import logging
import os

from fastapi import Depends, HTTPException, Request

from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import UserContext

logger = logging.getLogger(__name__)


async def get_user_context(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> UserContext:
    """Extract user context from the gateway's X-User-Context header.

    The Next.js API gateway authenticates the user (via session cookie or
    Bearer token) and injects a trusted ``X-User-Context`` header containing
    a base64-encoded JSON object.

    The decoded JSON is passed directly to ``UserContext``.  Only ``email``
    is required; all other fields (``name``, ``is_admin``, ``is_authorized``,
    ``can_view_admin``, etc.) are opaque and pass through via
    ``extra="allow"``.  This keeps the gateway in control of what
    authorization flags exist — DA doesn't need to know or care.

    Fallback behaviour:
    - If ``DEBUG=true`` (dev mode): returns a dev admin user.
    - If the header is missing or empty: returns 401 — all production
      traffic must be proxied through the Next.js gateway.
      Check the UI/API server logs to verify the gateway is injecting
      the X-User-Context header.
    - If the header is present but malformed: returns 400.
    """
    if settings.debug:
        logger.debug("Debug mode enabled (DEBUG=true), returning dev user")
        return UserContext(
            email="dev@localhost",
            name="Dev User",
            is_admin=True,
        )

    header = request.headers.get("X-User-Context")
    if not header:
        logger.warning(
            "Missing X-User-Context header — all requests must be proxied "
            "through the Next.js gateway. Check the UI/API server logs to "
            "verify the gateway is running and injecting this header."
        )
        raise HTTPException(
            status_code=401,
            detail=(
                "Missing X-User-Context header. Requests to Dynamic Agents "
                "must be proxied through the Next.js API gateway. "
                "Check the UI/API server logs for details."
            ),
        )

    secret = os.getenv("DA_USER_CONTEXT_HMAC_SECRET", "").strip()
    if not secret:
        logger.error("DA_USER_CONTEXT_HMAC_SECRET is not configured")
        raise HTTPException(
            status_code=503,
            detail="User context verification is not configured",
        )

    signature = request.headers.get("X-User-Context-Signature", "")
    expected = "v1=" + hmac.new(
        secret.encode("utf-8"),
        header.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        logger.warning("Missing or invalid X-User-Context signature")
        raise HTTPException(status_code=401, detail="Invalid user context signature")

    try:
        decoded = base64.b64decode(header)
        data = json.loads(decoded)
        return UserContext(**data)
    except Exception as e:
        logger.warning(f"Malformed X-User-Context header: {e}")
        raise HTTPException(
            status_code=400,
            detail="Malformed X-User-Context header",
        )


# Alias for backward compatibility with routes that import get_current_user
get_current_user = get_user_context


async def require_admin(
    user: UserContext = Depends(get_user_context),
) -> UserContext:
    """Require admin role for the endpoint."""
    if not user.is_admin:
        raise HTTPException(
            status_code=403,
            detail="Admin role required",
        )
    return user
