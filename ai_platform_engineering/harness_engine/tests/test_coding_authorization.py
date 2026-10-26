"""Long provider turns renew scoped owner credentials and repeat current CAS."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.coding.authorization import AuthorizedRunCredentials
from harness_engine.config import Settings

pytest_plugins = ["tests.coding_fixtures"]


def token(subject: str, revision: int) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"sub": subject, "revision": revision}).encode()).decode().rstrip("=")
    return "header." + payload + ".signature"


class Platform:
    def __init__(self, subject):
        self.subject, self.calls, self.mints, self.allowed = subject, [], 0, True

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url.endswith("/token"):
            self.mints += 1
            return httpx.Response(200, json={"access_token": token(self.subject, self.mints), "expires_in": 60})
        return httpx.Response(200, json={"decision": "ALLOW" if self.allowed else "DENY"})


def credentials(scope):
    db, context, _, _ = scope
    platform = Platform(context.binding.owner_subject)
    settings = Settings(
        storage_backend="memory",
        coding_platform_url="https://platform.example.test",
        coding_obo_token_url="https://identity.example.test/token",
        coding_obo_client_id="example",
        coding_obo_client_secret="example-secret",
    )
    return AuthorizedRunCredentials(settings, RunFence(db, context), client=platform), platform


async def test_owner_obo_renews_after_expiry_without_borrowing_browser_refresh_tokens(coding_scope):
    auth, platform = credentials(coding_scope)
    first = await auth.token()
    assert await auth.token() == first
    assert platform.mints == 1
    auth._expires_at = 0
    assert await auth.token() != first
    assert platform.mints == 2
    mint = platform.calls[0][1]["data"]
    assert mint["requested_subject"] == coding_scope[1].binding.owner_subject
    assert mint["grant_type"] == "urn:ietf:params:oauth:grant-type:token-exchange"
    assert "refresh_token" not in mint and "subject_token" not in mint
    assert coding_scope[0].harness_runs.find_one().get("access_token") is None


async def test_current_cas_revocation_stops_even_a_cached_unexpired_token(coding_scope):
    auth, platform = credentials(coding_scope)
    await auth.token()
    platform.allowed = False
    with pytest.raises(CodingAdmissionError, match="Current agent access"):
        await auth.token()
    assert platform.mints == 1


async def test_lease_or_owner_change_cannot_be_replaced_by_bare_subject(coding_scope):
    auth, platform = credentials(coding_scope)
    coding_scope[0].harness_sessions.update_one({}, {"$set": {"_producer_id": "producer-secondary"}})
    with pytest.raises(CodingAdmissionError):
        await auth.token()
    assert platform.calls == []


async def test_token_exchange_cannot_change_the_admitted_subject(coding_scope):
    auth, platform = credentials(coding_scope)
    platform.subject = "user-secondary"
    with pytest.raises(CodingAdmissionError, match="changed the admitted subject"):
        await auth.token()
    assert len(platform.calls) == 1


async def test_git_tool_permission_uses_existing_cas_call_action(coding_scope):
    auth, platform = credentials(coding_scope)
    await auth.authorize_resource("tool", "server-primary/write_example", "call")
    decision = platform.calls[-1][1]["json"]
    assert decision["resource"] == {"type": "tool", "id": "server-primary/write_example"}
    assert decision["action"] == "call"
    assert decision["subject"] == {"type": "user", "id": coding_scope[1].binding.owner_subject}
