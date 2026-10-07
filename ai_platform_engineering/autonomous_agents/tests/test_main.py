"""Application-level error handling tests."""

import json

from starlette.requests import Request

from autonomous_agents.error_handlers import webhook_secret_encryption_error_handler
from autonomous_agents.services.secret_encryption import WebhookSecretEncryptionError


async def test_webhook_secret_encryption_failure_returns_actionable_json() -> None:
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/tasks",
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("testserver", 80),
        }
    )
    response = await webhook_secret_encryption_error_handler(
        request,
        WebhookSecretEncryptionError("provider-specific internal detail"),
    )

    assert response.status_code == 503
    assert response.media_type == "application/json"
    assert json.loads(response.body) == {
        "detail": (
            "Webhook secret encryption is unavailable. Check "
            "CREDENTIAL_KMS_CMK_ID and the Autonomous Agents service's "
            "AWS KMS permissions."
        )
    }
    assert b"provider-specific internal detail" not in response.body
