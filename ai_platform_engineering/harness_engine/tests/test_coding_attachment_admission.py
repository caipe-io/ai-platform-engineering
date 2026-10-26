"""First-turn attachment admission uses the canonical route, not a fake run."""

from __future__ import annotations

import json
import os

import httpx
import pytest

from harness_engine.adapters.claude_code_acp import ClaudeCodeACPAdapter
from harness_engine.coding import routes
from harness_engine.coding.admission import CodingAdmissionError
from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.repository import MongoRunRepository

pytest_plugins = ["tests.coding_fixtures"]


@pytest.mark.parametrize("alias", [False, True])
async def test_first_prompt_upload_rechecks_authorization_before_and_after_bytes(coding_scope, monkeypatch, alias):
    db, context, _, _ = coding_scope
    db.harness_runs.delete_many({})
    db.harness_sessions.delete_many({})
    visible = context.binding.conversation_id
    if alias:
        conversation = db.conversations.find_one()
        db.conversations.delete_one({"_id": conversation["_id"]})
        visible = "visible-example"
        db.conversations.insert_one(
            {**conversation, "_id": visible, "execution_context_id": context.binding.conversation_id}
        )
    checks = []

    class Credentials:
        def __init__(self, settings, fence):
            self.fence = fence

        async def token(self):
            await self.fence.require()
            checks.append("fresh-agent-use")
            return "owner-bearer"

    monkeypatch.setattr(routes, "AuthorizedRunCredentials", Credentials)
    settings = Settings(
        storage_backend="mongodb",
        internal_token="test-internal-token-value",
        mongodb_uri=os.environ["HARNESS_ENGINE_TEST_MONGODB_URI"],
        mongodb_database=db.name,
        claude_code_profiles_json=json.dumps({"primary": {"sandbox_profile_id": "primary", "revision": "r1"}}),
        coding_sandbox_service_url="https://sandbox.example.test",
        coding_resources_url="https://resources.example.test",
        coding_platform_url="https://platform.example.test",
        coding_tools_public_url="https://broker.example.test",
        coding_obo_token_url="https://identity.example.test/token",
        coding_obo_client_id="example",
        coding_obo_client_secret="example-secret",
    )
    repository = MongoRunRepository(settings.mongodb_uri, db.name, 86400)
    adapter = ClaudeCodeACPAdapter(settings, repository=repository)
    app = create_app(settings=settings, repository=repository, adapters=[adapter])
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.post(
            "/api/v1/attachments",
            headers={
                "Authorization": "Bearer test-internal-token-value",
                "X-Harness-Engine-Subject": context.binding.owner_subject,
            },
            json={
                "agent_id": context.binding.agent_id,
                "conversation_id": context.binding.conversation_id,
                "visible_conversation_id": visible,
                "expected_harness_id": "claude_code_acp",
                "name": "example.txt",
                "media_type": "text/plain",
                "data": "ZXhhbXBsZQ==",
            },
        )
        assert response.status_code == 201, response.text
        assert response.json()["data"]["size_bytes"] == 7
        assert checks == ["fresh-agent-use", "fresh-agent-use"]
        assert db.harness_runs.count_documents({}) == 0
        assert db.harness_sessions.count_documents({}) == 0
        assert db["harness_attachments.files"].count_documents({}) == 1
        db.conversations.update_one({"_id": visible}, {"$set": {"owner_subject": "user-secondary"}})
        denied = await client.post(
            "/api/v1/attachments",
            headers={
                "Authorization": "Bearer test-internal-token-value",
                "X-Harness-Engine-Subject": context.binding.owner_subject,
            },
            json={
                "agent_id": context.binding.agent_id,
                "conversation_id": context.binding.conversation_id,
                "visible_conversation_id": visible,
                "expected_harness_id": "claude_code_acp",
                "name": "other.txt",
                "media_type": "text/plain",
                "data": "ZXhhbXBsZQ==",
            },
        )
        assert denied.status_code == 409
        assert db["harness_attachments.files"].count_documents({}) == 1


async def test_pre_run_current_cas_denial_prevents_upload(coding_scope, monkeypatch):
    # The route's authorizer must run before invoking the byte store.
    class Denied:
        def __init__(self, settings, fence):
            pass

        async def token(self):
            raise CodingAdmissionError("Current agent use was revoked")

    monkeypatch.setattr(routes, "AuthorizedRunCredentials", Denied)
    db, context, _, _ = coding_scope
    settings = Settings(
        storage_backend="mongodb",
        internal_token="test-internal-token-value",
        mongodb_uri=os.environ["HARNESS_ENGINE_TEST_MONGODB_URI"],
        mongodb_database=db.name,
        claude_code_profiles_json=json.dumps({"primary": {"sandbox_profile_id": "primary", "revision": "r1"}}),
        coding_sandbox_service_url="https://sandbox.example.test",
        coding_resources_url="https://resources.example.test",
        coding_platform_url="https://platform.example.test",
        coding_tools_public_url="https://broker.example.test",
        coding_obo_token_url="https://identity.example.test/token",
        coding_obo_client_id="example",
        coding_obo_client_secret="example-secret",
    )
    repository = MongoRunRepository(settings.mongodb_uri, db.name, 86400)
    adapter = ClaudeCodeACPAdapter(settings, repository=repository)
    app = create_app(settings=settings, repository=repository, adapters=[adapter])
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.post(
            "/api/v1/attachments",
            headers={
                "Authorization": "Bearer test-internal-token-value",
                "X-Harness-Engine-Subject": context.binding.owner_subject,
            },
            json={
                "agent_id": context.binding.agent_id,
                "conversation_id": context.binding.conversation_id,
                "expected_harness_id": "claude_code_acp",
                "name": "example.txt",
                "media_type": "text/plain",
                "data": "ZXhhbXBsZQ==",
            },
        )
        assert response.status_code == 409
        assert db["harness_attachments.files"].count_documents({}) == 0
