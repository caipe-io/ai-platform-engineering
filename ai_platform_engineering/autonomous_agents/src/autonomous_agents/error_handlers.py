"""Application-level exception handlers."""

import logging

from fastapi import Request
from fastapi.responses import JSONResponse

from autonomous_agents.services.secret_encryption import WebhookSecretEncryptionError

logger = logging.getLogger("autonomous_agents")


async def webhook_secret_encryption_error_handler(
    request: Request,
    exc: WebhookSecretEncryptionError,
) -> JSONResponse:
    """Return a stable JSON error without exposing encryption internals."""
    logger.error(
        "Webhook secret encryption failed for %s %s: %s",
        request.method,
        request.url.path,
        exc,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return JSONResponse(
        status_code=503,
        content={
            "detail": (
                "Webhook secret encryption is unavailable. Check "
                "CREDENTIAL_KMS_CMK_ID and the Autonomous Agents service's "
                "AWS KMS permissions."
            )
        },
    )
