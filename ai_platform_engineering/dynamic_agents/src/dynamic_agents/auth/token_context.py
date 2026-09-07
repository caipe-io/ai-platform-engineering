"""Per-request bearer token context for Dynamic Agents.

Spec 102 Phase 8 / T101.

This is the DA-local mirror of the shared
``ai_platform_engineering.utils.auth.token_context.current_bearer_token``.
It exists in this package so the DA's own auth middleware and httpx client
factory can be wired together without taking a dependency on the shared
``ai_platform_engineering`` package (the DA ships as its own deploy unit).

The middleware (``jwt_middleware.JwtAuthMiddleware``) sets
``current_user_token`` on every request after validating the incoming
Bearer JWT against Keycloak JWKS. The MCP client factory in
``services/mcp_client.py`` reads it on every outbound request to forward
the user's identity to ``agentgateway`` and downstream MCP servers.

Each asyncio Task inherits a copy of the ContextVar context, so
concurrent requests are fully isolated.
"""

from contextvars import ContextVar
from typing import Optional

current_user_token: ContextVar[Optional[str]] = ContextVar(
    "current_user_token", default=None
)

current_user_sub: ContextVar[Optional[str]] = ContextVar(
    "current_user_sub", default=None
)

current_traceparent: ContextVar[Optional[str]] = ContextVar(
    "current_traceparent", default=None
)
