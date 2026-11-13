"""Exercise the shared connection path with local OpenAI-compatible endpoints."""

import json
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from dynamic_agents.models import UserContext
from dynamic_agents.routes.llm_models import ModelTestRequest, diagnostic
from dynamic_agents.routes.llm_models import test_model as run_test
from dynamic_agents.services import model_connections
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.model_connections import ResolvedModel
from dynamic_agents.services.runtime_cache import AgentRuntimeCache


@contextmanager
def endpoint(status: int = 200, redirect: str | None = None):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, self.headers.get("Authorization"), body))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if redirect:
                self.send_header("Location", redirect)
            self.end_headers()
            payload = {"id": "example", "object": "chat.completion", "model": "example-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}]}
            if status != 200:
                payload = {"error": {"message": "Invalid example-private-key for example-model", "type": "invalid_request_error", "code": "invalid_api_key"}}
            self.wfile.write(json.dumps(payload).encode())

        def log_message(self, *_args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", calls
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def plan(url: str) -> ResolvedModel:
    return ResolvedModel("example-model", "openai-compatible", "first", {"base_url": url, "api_key": "example-private-key"})


async def test_testing_and_normal_invocation_use_identical_native_configuration(monkeypatch) -> None:
    user = UserContext(email="test-user@example.test")
    with endpoint() as (url, calls):
        selected = plan(url)
        monkeypatch.setattr("dynamic_agents.routes.llm_models.resolve_model", AsyncMock(return_value=selected))
        result = await run_test(ModelTestRequest(model_id="registry-model"), user)
        assert result["success"] is True
        chat = selected.instantiate(streaming=False)
        try:
            assert (await chat.ainvoke("Example chat", max_tokens=32)).content == "OK"
        finally:
            chat.http_client.close()
            await chat.http_async_client.aclose()
        assert len(calls) == 2
        assert all(path == "/v1/chat/completions" and auth == "Bearer example-private-key" and body["model"] == "example-model" for path, auth, body in calls)


async def test_same_model_on_two_endpoints_does_not_share_credentials() -> None:
    with endpoint() as (first_url, first), endpoint() as (second_url, second):
        a = plan(first_url).instantiate()
        second_plan = plan(second_url)
        second_plan.parameters["api_key"] = "secondary-private-key"
        b = second_plan.instantiate()
        try:
            await a.ainvoke("OK", max_tokens=32)
            await b.ainvoke("OK", max_tokens=32)
            assert first[0][1] == "Bearer example-private-key"
            assert second[0][1] == "Bearer secondary-private-key"
        finally:
            for model in (a, b):
                model.http_client.close()
                await model.http_async_client.aclose()


async def test_provider_authentication_error_keeps_diagnostic_and_redacts_key(monkeypatch) -> None:
    with endpoint(401) as (url, _):
        monkeypatch.setattr("dynamic_agents.routes.llm_models.resolve_model", AsyncMock(return_value=plan(url)))
        result = await run_test(ModelTestRequest(model_id="registry"), UserContext(email="test-user@example.test"))
        assert result["category"] == "authentication"
        assert result["status_code"] == 401
        assert "Invalid" in result["message"]
        assert "example-private-key" not in json.dumps(result)


async def test_credentials_are_never_forwarded_to_redirect_target() -> None:
    with endpoint() as (target, received), endpoint(307, target + "/chat/completions") as (url, source):
        chat = plan(url).instantiate()
        try:
            with pytest.raises(Exception):
                await chat.ainvoke("OK", max_tokens=32)
            assert len(source) >= 1
            assert received == []
        finally:
            chat.http_client.close()
            await chat.http_async_client.aclose()


async def test_registered_connections_fail_closed_without_broker(monkeypatch) -> None:
    mongo = SimpleNamespace(get_llm_model=Mock(return_value={"connection_id": "connection"}))
    monkeypatch.setattr(model_connections, "broker", Mock(side_effect=model_connections.LLMConfigError("missing service")))
    with pytest.raises(model_connections.LLMConfigError, match="missing service"):
        await model_connections.resolve_registered_model(SimpleNamespace(), None, mongo, "registry")
    mongo.get_llm_model.return_value = {"model_id": "legacy"}
    assert await model_connections.resolve_registered_model(SimpleNamespace(), None, mongo, "legacy") is None


async def test_cached_graph_rechecks_current_user_and_rotation(monkeypatch) -> None:
    runtime = object.__new__(AgentRuntime)
    runtime._model_connection_revisions = {"registry": "first"}
    runtime.settings = SimpleNamespace()
    runtime._mongo_service = object()
    user = UserContext(email="test-user@example.test")
    resolver = AsyncMock(return_value=ResolvedModel("example-model", "openai", "first"))
    monkeypatch.setattr("dynamic_agents.services.agent_runtime.resolve_registered_model", resolver)
    assert await runtime.model_credentials_current(user)
    resolver.assert_awaited_with(runtime.settings, user, runtime._mongo_service, "registry", metadata_only=True)
    resolver.return_value.revision = "rotated"
    assert not await runtime.model_credentials_current(user)
    resolver.side_effect = model_connections.LLMConfigError("revoked")
    with pytest.raises(model_connections.LLMConfigError, match="revoked"):
        await runtime.model_credentials_current(user)


async def test_cache_does_not_return_graph_after_credential_revocation() -> None:
    cache = AgentRuntimeCache(max_size=2)
    agent = SimpleNamespace(id="example-agent")
    runtime = SimpleNamespace(_client_context=None, _is_streaming=False, model_credentials_current=AsyncMock(side_effect=model_connections.LLMConfigError("revoked")))
    cache._cache["example-agent:example-session"] = runtime
    with pytest.raises(model_connections.LLMConfigError, match="revoked"):
        await cache.get_or_create(agent, [], "example-session")


@pytest.mark.parametrize(("error", "category"), [(TimeoutError("deadline"), "timeout"), (httpx.ConnectError("DNS failed"), "connection"), (ValueError("certificate verify failed"), "tls")])
def test_network_diagnostics(error: Exception, category: str) -> None:
    assert diagnostic(error, None)["category"] == category

async def test_model_cleanup_preserves_shared_deployment_transports() -> None:
    from dynamic_agents.services.llm_clients import close_model_transports

    shared = SimpleNamespace(http_client=Mock(), http_async_client=AsyncMock())
    await close_model_transports(shared)
    shared.http_client.close.assert_not_called()
    shared.http_async_client.aclose.assert_not_called()
    owned = SimpleNamespace(_caipe_owned_transports=(Mock(), AsyncMock()))
    clients = owned._caipe_owned_transports
    await close_model_transports(owned)
    clients[0].close.assert_called_once()
    clients[1].aclose.assert_awaited_once()


async def test_removed_registered_connection_never_falls_back_to_environment() -> None:
    registry_id = "00000000-0000-4000-8000-000000000001-0123456789abcdef"
    mongo = SimpleNamespace(get_llm_model=Mock(return_value=None))
    with pytest.raises(model_connections.LLMConfigError, match="removed"):
        await model_connections.resolve_registered_model(SimpleNamespace(), None, mongo, registry_id)
