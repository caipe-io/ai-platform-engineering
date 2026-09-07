"""Starlette middleware that validates incoming Bearer JWTs against Keycloak.

Spec 102 Phase 8 / T102.

For every request:

1. If the incoming request carries an ``Authorization: Bearer <jwt>``
   header, validate the JWT against Keycloak's JWKS endpoint
   (``OIDC_DISCOVERY_URL`` / ``OIDC_ISSUER`` / ``OIDC_AUDIENCE``).
2. On success, set ``current_user_token`` ContextVar so downstream
   ``services/mcp_client.py`` will forward this exact token (no
   re-mint, no swap) to ``agentgateway`` and downstream MCP servers.
3. On failure (expired / wrong-issuer / wrong-audience / signature
   mismatch), respond 401 immediately with a structured JSON body so
   the BFF can render a meaningful UI error. The request never reaches
   route handlers.
4. If there is **no** ``Authorization`` header at all, this middleware
   is intentionally lenient: it lets the request through and the
   existing ``auth.get_user_context`` dependency handles the
   ``X-User-Context`` legacy path. This is the rollout-safety hatch
   so the BFF can keep sending the trusted-header form for now;
   migrating the BFF to send Bearer is the matching change in
   ``ui/src/lib/da-proxy.ts``.

The two-path lenience MUST be removed once the BFF migration is
complete — at which point we hard-fail on no-bearer (FR-004 from
spec 102, Story 6 acceptance scenario 3).
"""

from __future__ import annotations

import json
import logging
import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from dynamic_agents.auth.token_context import current_traceparent, current_user_sub, current_user_token

logger = logging.getLogger(__name__)

# Module-level toggle: when SET (any non-empty string), every request MUST
# carry a valid Bearer token; X-User-Context becomes invalid. This is the
# kill-switch we flip after the BFF migration in ui/src/lib/da-proxy.ts.
# Default OFF (lenient) so this rollout step does not break the live stack.
DA_REQUIRE_BEARER = os.environ.get("DA_REQUIRE_BEARER", "").strip().lower() in (
    "1",
    "true",
    "yes",
)

# Probe / observability endpoints must stay reachable without auth so Docker
# healthchecks and Prometheus scrapes do not flap when bearer enforcement is on.
PUBLIC_PATHS = frozenset({"/health", "/healthz", "/readyz", "/metrics"})


def _validate_bearer_or_none(token: str) -> dict | None:
    """Validate JWT against Keycloak; return claims dict on success, None on failure.

    Uses the vendored ``dynamic_agents.auth.jwks_validate`` helper so the
    runtime image (which only ships the ``dynamic_agents`` package) can
    validate tokens without importing the broader
    ``ai_platform_engineering.utils.*`` namespace. Lazy import keeps cold
    starts fast and avoids pulling crypto deps until the first Bearer
    request hits the gate.
    """
    try:
        from dynamic_agents.auth.jwks_validate import validate_bearer_jwt

        return validate_bearer_jwt(token)  # type: ignore[no-any-return]
    except Exception as exc:  # noqa: BLE001
        logger.warning("Bearer token validation failed: %s", exc)
        return None


class JwtAuthMiddleware(BaseHTTPMiddleware):
    """Validate incoming Bearer JWTs and bind ``current_user_token``.

    See module docstring for the rollout-safety lenience policy.
    """

    async def dispatch(self, request: Request, call_next):
        if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        authorization = request.headers.get("authorization", "")
        token: str | None = None
        subject: str | None = None

        if authorization.lower().startswith("bearer "):
            raw = authorization[7:].strip()
            if raw:
                claims = _validate_bearer_or_none(raw)
                if claims is None:
                    # Reject hard: the caller sent a Bearer header but it
                    # was invalid. Do NOT silently fall through to
                    # X-User-Context — that would let an attacker bypass
                    # JWT validation by appending a forged trusted header.
                    body = json.dumps(
                        {
                            "error": "Invalid or expired bearer token",
                            "code": "bearer_invalid",
                            "reason": "bearer_invalid",
                            "action": "sign_in",
                        }
                    ).encode("utf-8")
                    return Response(
                        content=body,
                        status_code=401,
                        media_type="application/json",
                    )
                token = raw
                subject = str(claims.get("sub") or "").strip() or None
                # The legacy team-claim log field was removed by spec
                # 2026-05-24-derive-team-from-channel Phase 2.8: team is
                # not carried on the JWT. Triage of "wrong team" now
                # uses the channel→team mapping audit on the BFF
                # side. We keep `sub` + `aud` because both still
                # answer real operator questions.
                logger.info(
                    "Bearer token validated: sub=%s aud=%s",
                    claims.get("sub"),
                    claims.get("aud"),
                )
        elif DA_REQUIRE_BEARER:
            body = json.dumps(
                {
                    "error": "Authentication required (Bearer token)",
                    "code": "missing_bearer",
                    "reason": "not_signed_in",
                    "action": "sign_in",
                }
            ).encode("utf-8")
            return Response(
                content=body, status_code=401, media_type="application/json"
            )

        traceparent = request.headers.get("traceparent")
        trace_ctx_token = current_traceparent.set(traceparent if traceparent else None)
        ctx_token = current_user_token.set(token)
        sub_ctx_token = current_user_sub.set(subject)
        try:
            return await call_next(request)
        finally:
            current_user_sub.reset(sub_ctx_token)
            current_user_token.reset(ctx_token)
            current_traceparent.reset(trace_ctx_token)
