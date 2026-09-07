# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by claude code claude-sonnet-4-6

"""Per-request bearer token context for propagating auth tokens to downstream services.

Auth middlewares (SharedKeyMiddleware, OAuth2Middleware, DualAuthMiddleware) set
current_bearer_token after validating an incoming request.  The LangGraph MCP client
factory reads it when opening each HTTP connection so the token is forwarded to
MCP servers without any changes to the agent's call signature.

Each asyncio Task inherits a copy of the ContextVar context, so concurrent requests
are fully isolated.
"""

from contextvars import ContextVar
from typing import Optional

current_bearer_token: ContextVar[Optional[str]] = ContextVar(
    "current_bearer_token", default=None
)
