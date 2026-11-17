from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

import httpx2 as httpx
import mongomock
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from pymongo.errors import AutoReconnect

from harness_engine.acp_events import EXTENSION
from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.adapters.claude_sdk import ClaudeSDKAdapter
from harness_engine.claude_worker import create_worker_app
from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.models import RegisteredClaudeProfile
from harness_engine.repository import InMemoryRunRepository, MongoRunRepository
from tests.conftest import auth_headers, blueprint
from tests.test_claude_acp import process_adapter
from tests.test_claude_workers import configured_worker, context, result, rpc_response


def profile(**changes: Any) -> dict[str, Any]:
    return dict(profile_id="managed-example-v1", harness_id="claude_agent_sdk", base_profile_id="safe",
                display_name="Long investigation", model="example-model-large", max_turns=50, **changes)


def admin() -> dict[str, str]:
    return {**auth_headers(), "X-Harness-Engine-Admin": "true"}


@pytest.mark.parametrize("mongo", [False, True])
def test_profile_authorization_immutability_and_replica_refresh(settings, monkeypatch, mongo):
    if mongo:
        db = mongomock.MongoClient(tz_aware=True)
        monkeypatch.setattr("harness_engine.repository.MongoClient", lambda *a, **kw: db)
        repo = MongoRunRepository("mongodb://example.test", "test", 3600)
    else:
        repo = InMemoryRunRepository()
    first = create_app(settings=settings, repository=repo)
    second = create_app(settings=settings, repository=repo)
    with TestClient(first) as client, TestClient(second) as replica:
        path = "/api/v1/admin/operator-profiles"
        assert client.post(path, json=profile()).status_code == 401
        assert client.post(path, headers=auth_headers(), json=profile()).status_code == 403
        assert client.get(path, headers=auth_headers()).status_code == 403
        assert client.post(path, headers=admin(), json=profile()).status_code == 201
        assert client.post(path, headers=admin(), json={**profile(), "model": "other"}).status_code == 409
        data = replica.get(path, headers=admin()).json()["data"]
        assert data["profiles"][0]["model"] == "example-model-large"
        assert "internal_token" not in str(data) and "mongodb" not in str(data)
        draft = blueprint(harness_id="claude_agent_sdk", profile_id="managed-example-v1")
        validated = replica.post("/api/v1/agent-drafts/validate", headers=auth_headers(), json={"blueprint": draft}).json()["data"]
        assert validated["valid"]
        assert validated["normalized_blueprint"]["harness"]["options"]["max_turns"] == 50
        draft["harness"]["options"] = {"max_turns": 80}
        assert replica.post("/api/v1/agent-drafts/validate", headers=auth_headers(), json={"blueprint": draft}).json()["data"]["normalized_blueprint"]["harness"]["options"]["max_turns"] == 80
        for changes in ({"max_turns": 101}, {"max_turns": 0}, {"max_turns": 2.5}, {"url": "http://other.test"}, {"token": "credential"}, {"model": "model\nheader"}):
            assert client.post(path, headers=admin(), json={**profile(), **changes}).status_code == 422
        assert client.post(path, headers=admin(), json={**profile(), "profile_id": "managed-other", "base_profile_id": "missing"}).status_code == 400
        assert client.post(path, headers=admin(), json={**profile(), "profile_id": "managed-other", "base_profile_id": "managed-example-v1"}).status_code == 400


@pytest.mark.parametrize("refresh_error", [AutoReconnect, ValueError, RuntimeError])
def test_committed_profile_publication_succeeds_when_immediate_refresh_fails(settings: Settings, refresh_error: type[Exception]) -> None:
    class FlakyRepository(InMemoryRunRepository):
        fail_refresh: bool = False

        async def create_claude_profile(self, saved: RegisteredClaudeProfile) -> None:
            await super().create_claude_profile(saved)
            self.fail_refresh = True

        async def list_claude_profiles(self) -> list[RegisteredClaudeProfile]:
            if self.fail_refresh:
                self.fail_refresh = False
                raise refresh_error("Temporary catalog read failure")
            return await super().list_claude_profiles()

    repo = FlakyRepository()
    app = create_app(settings=settings, repository=repo)
    path = "/api/v1/admin/operator-profiles"
    with TestClient(app) as client:
        response = client.post(path, headers=admin(), json=profile())
        assert response.status_code == 201
        assert response.json()["data"]["profile_id"] == "managed-example-v1"
        restored = client.get(path, headers=admin())
        assert restored.status_code == 200
        assert restored.json()["data"]["profiles"][0]["profile_id"] == "managed-example-v1"
        native = next(h for h in restored.json()["data"]["harnesses"] if h["id"] == "claude_agent_sdk")
        assert any(p["id"] == "managed-example-v1" and p["model"] == "example-model-large" for p in native["profiles"])
        assert client.post(path, headers=admin(), json=profile()).status_code == 409


async def test_deployment_model_discovery_runs_concurrently_and_preserves_partial_results(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("harness_engine.adapters.claude_remote.MODEL_DISCOVERY_TIMEOUT_SECONDS", .1)
    seen: set[str] = set()
    all_started = asyncio.Event()
    cancelled: set[str] = set()
    config = settings.model_copy(update={"claude_worker_profiles_json": SecretStr(json.dumps({
        alias: {"url": f"http://{alias}.example.test", "token": "test-worker-secret", "profile_id": "safe"}
        for alias in ("ready", "slow", "unavailable")
    }))})

    async def worker(request: httpx.Request) -> httpx.Response:
        alias = request.url.host.split(".")[0]
        assert request.headers["authorization"] == "Bearer test-worker-secret"
        assert request.headers["x-harness-engine-subject"] == "test-user"
        seen.add(alias)
        if len(seen) == 3:
            all_started.set()
        await all_started.wait()
        if alias == "ready":
            return httpx.Response(200, json={"profiles": [{"id": "safe", "model": "example-model"}]})
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.add(alias)
        raise AssertionError("Unreachable")

    remote = RemoteClaudeSDKAdapter(config, httpx.MockTransport(worker))
    assert await asyncio.wait_for(remote.deployment_models("test-user"), 1) == {"ready": "example-model"}
    assert seen == {"ready", "slow", "unavailable"}
    assert cancelled == {"slow", "unavailable"}


async def test_operator_catalog_discovers_remote_adapters_concurrently(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    first = RemoteClaudeSDKAdapter(configured_worker(settings))
    second = RemoteClaudeSDKAdapter(configured_worker(settings), claude_acp=True)
    seen: set[str] = set()
    all_started = asyncio.Event()

    async def discover(adapter: RemoteClaudeSDKAdapter, subject: str) -> dict[str, str]:
        assert subject == "test-user"
        seen.add(adapter.descriptor.id)
        if len(seen) == 2:
            all_started.set()
        await asyncio.wait_for(all_started.wait(), 1)
        return {}

    monkeypatch.setattr(first, "deployment_models", lambda subject: discover(first, subject))
    monkeypatch.setattr(second, "deployment_models", lambda subject: discover(second, subject))
    app = create_app(settings=settings, repository=InMemoryRunRepository(), adapters=[first, second])
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://engine.example.test") as client:
            response = await client.get("/api/v1/admin/operator-profiles", headers=admin())
    assert response.status_code == 200
    assert len(response.json()["data"]["harnesses"]) == 2


async def test_catalog_refresh_cannot_install_a_stale_snapshot_after_publication(settings: Settings) -> None:
    class SnapshotRepository(InMemoryRunRepository):
        hold_next_read = False

        async def list_claude_profiles(self) -> list[RegisteredClaudeProfile]:
            snapshot = await super().list_claude_profiles()
            if self.hold_next_read:
                self.hold_next_read = False
                captured.set()
                await release.wait()
            return snapshot

    captured, release = asyncio.Event(), asyncio.Event()
    repo = SnapshotRepository()
    native = ClaudeSDKAdapter(settings)
    app = create_app(settings=settings, repository=repo, adapters=[native])
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://engine.example.test") as client:
            repo.hold_next_read = True
            older = asyncio.create_task(client.get("/api/v1/harnesses", headers=auth_headers()))
            await asyncio.wait_for(captured.wait(), 1)
            publication = asyncio.create_task(client.post("/api/v1/admin/operator-profiles", headers=admin(), json=profile()))
            try:
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(publication), .1)
            finally:
                release.set()
                older_response, saved_response = await asyncio.gather(older, publication)
            assert older_response.status_code == 200
            assert saved_response.status_code == 201
            assert any(p.id == "managed-example-v1" for p in native.descriptor.profiles)


@pytest.mark.parametrize("failure, expected", [("http", "status=503"), ("connection", "error=ConnectError"), ("malformed", "error=AttributeError")])
async def test_worker_discovery_logs_context_without_credentials(settings: Settings, caplog: pytest.LogCaptureFixture, failure: str, expected: str) -> None:
    sensitive = "private-worker-credential-and-response"

    async def worker(request: httpx.Request) -> httpx.Response:
        if failure == "connection":
            raise httpx.ConnectError(sensitive, request=request)
        if failure == "http":
            return httpx.Response(503, text=sensitive)
        return httpx.Response(200, json={"profiles": [sensitive]})

    remote = RemoteClaudeSDKAdapter(configured_worker(settings), httpx.MockTransport(worker))
    caplog.set_level("WARNING", logger="harness_engine.adapters.claude_remote")
    assert await remote.deployment_models(sensitive) == {}
    assert "alias=remote" in caplog.text and expected in caplog.text
    assert sensitive not in caplog.text and "test-worker-secret" not in caplog.text


async def test_remote_profile_model_reaches_worker_without_changing_base(settings):
    seen = []

    async def query(**kwargs):
        seen.append((kwargs["options"].model, kwargs["options"].max_turns, kwargs["options"].permission_mode))
        yield result()

    worker = create_worker_app(settings=settings.model_copy(update={"internal_token": "test-worker-secret"}),
                               repository=InMemoryRunRepository(), adapter=ClaudeSDKAdapter(settings, query_fn=query))
    remote = RemoteClaudeSDKAdapter(configured_worker(settings), httpx.ASGITransport(app=worker))
    repo = InMemoryRunRepository()
    managed = {**profile(), "harness_id": "claude_agent_sdk_remote", "base_profile_id": "remote"}
    await repo.create_claude_profile(RegisteredClaudeProfile(**managed, created_by="admin"))
    parent = create_app(settings=settings, repository=repo, adapters=[remote])
    async with worker.router.lifespan_context(worker), parent.router.lifespan_context(parent):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=parent), base_url="http://engine.example.test", headers=auth_headers()) as client:
            assert (await client.post("/api/v1/runs", json={"agent_id": "agent-example", "conversation_id": "example", "message": "hello", "operator_model": "unapproved-model"})).status_code == 422
            assert await remote.deployment_models("test-user") == {"remote": settings.claude_sdk_profiles()["safe"].model}
            for selected in ("managed-example-v1", "remote"):
                draft = blueprint(harness_id="claude_agent_sdk_remote", profile_id=selected)
                draft["id"] = "agent-" + selected
                saved = await client.put("/api/v1/agents/" + draft["id"], json={"blueprint": draft})
                assert saved.status_code == 200, saved.text
                response = await client.post("/api/v1/runs", json={"agent_id": draft["id"], "conversation_id": selected, "message": "hello"})
                assert response.status_code == 202, response.text
                run_id = response.json()["data"]["run_id"]
                for _ in range(100):
                    run = (await client.get("/api/v1/runs/" + run_id)).json()["data"]
                    if run["status"] in {"completed", "failed"}:
                        break
                    await asyncio.sleep(0.01)
                assert run["status"] == "completed", run
    assert seen[0][:2] == ("example-model-large", 50)
    assert seen[1][:2] == (settings.claude_sdk_profiles()["safe"].model, 20)
    assert seen[0][2] == seen[1][2] == settings.claude_sdk_profiles()["safe"].permission_mode


async def test_managed_profile_requires_worker_capability_before_execution(settings):
    methods = []

    def legacy_worker(request):
        rpc = json.loads(request.content)
        methods.append(rpc["method"])
        return rpc_response(rpc, {"protocolVersion": 1, "_meta": {EXTENSION: {"durableReplay": True, "runtime": "sdk"}}})

    remote = RemoteClaudeSDKAdapter(configured_worker(settings), httpx.MockTransport(legacy_worker))
    remote.set_registered_profiles([RegisteredClaudeProfile(**{**profile(), "harness_id": "claude_agent_sdk_remote", "base_profile_id": "remote"}, created_by="admin")])
    ctx = context()
    ctx.binding.profile_id = ctx.blueprint.harness.profile_id = "managed-example-v1"
    ctx.binding.harness_id = ctx.blueprint.harness.id = "claude_agent_sdk_remote"
    with pytest.raises(ValueError, match="Upgrade the worker"):
        _ = [event async for event in remote.execute(ctx)]
    assert methods == ["initialize"]


async def test_operator_model_and_higher_turns_reach_acp_process(settings):
    ctx = context()
    ctx.operator_model = "example-model-large"
    ctx.blueprint.tools.bindings = []
    ctx.blueprint.harness.options = {"max_turns": 100}
    _ = [event async for event in process_adapter(settings).execute(ctx)]
    directory = hashlib.sha256(ctx.binding.binding_id.encode()).hexdigest()
    policy = json.loads((Path(settings.claude_sdk_profiles()["safe"].cwd) / directory / "session.json").read_text())
    options = policy["_meta"]["claudeCode"]["options"]
    assert options["model"] == "example-model-large"
    assert options["maxTurns"] == 100
    assert options["allowDangerouslySkipPermissions"] is False
    assert options["settingSources"] == []
