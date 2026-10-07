"""Gateway-trusted authentication for Dynamic Agents.

All requests to DA are proxied through the Next.js gateway, which handles
OIDC authentication and session management.  The gateway injects a trusted
``X-User-Context`` header (base64-encoded JSON) containing pre-computed
authorization flags.

Bearer-token validation is handled by JWT middleware.
"""

import base64
import json
import logging

from fastapi import Depends, HTTPException, Request

from dynamic_agents.models import UserContext

logger = logging.getLogger(__name__)


async def get_user_context(
    request: Request,
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
    - If the header is missing or empty: returns 401 — all production
      traffic must be proxied through the Next.js gateway.
      Check the UI/API server logs to verify the gateway is injecting
      the X-User-Context header.
    - If the header is present but malformed: returns 400.
    """
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
