"""Discovery is bounded, anonymous, namespace-scoped and never auto-registers."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException

from dynamic_agents.routes import remote_agents
from dynamic_agents.services import a2a_kubernetes_discovery as kubernetes


async def test_public_discovery_keeps_successes_and_per_url_errors_without_credentials(monkeypatch):
    async def read(payload):
        assert payload.credential_source.kind == "none"
        if payload.endpoint.endswith("missing"):
            raise HTTPException(502, "Agent Card unavailable")
        return remote_agents.RemoteAgentProbeResponse(name="Example", description="Example agent", protocol_bindings=["JSONRPC"])
    resolver = AsyncMock(side_effect=read)
    monkeypatch.setattr(remote_agents, "read_agent_card", resolver)
    result = await remote_agents.discover_remote_agents(remote_agents.DiscoveryRequest(source="urls",
        urls=["https://example.test", "https://example.test/missing", "https://example.test"]), None)
    assert len(result["items"]) == 2 and resolver.await_count == 2
    assert result["items"][0]["name"] == "Example"
    assert result["items"][1]["error"] == "Agent Card unavailable"


async def test_kubernetes_scope_is_checked_before_reading_the_service_account():
    with pytest.raises(ValueError, match="configured"):
        await kubernetes.discover_services("other", ["primary"], "cluster.local")


async def test_service_account_credentials_stay_on_the_kubernetes_api(monkeypatch, tmp_path):
    (tmp_path / "token").write_text("cluster-token")
    (tmp_path / "ca.crt").write_text("cluster-ca")
    monkeypatch.setattr(kubernetes, "SERVICE_ACCOUNT", tmp_path)
    monkeypatch.setattr(kubernetes.ssl, "create_default_context", lambda **kwargs: object())
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, stream=httpx.ByteStream(b'{"items": []}'))
    monkeypatch.setattr(kubernetes.httpx, "AsyncHTTPTransport", lambda **kwargs: httpx.MockTransport(respond))
    assert await kubernetes.discover_services("primary", ["primary"], "cluster.local") == []
    assert len(requests) == 2
    assert all(request.url.host == "kubernetes.default.svc" and request.url.scheme == "https" for request in requests)
    assert all(request.headers["Authorization"] == "Bearer cluster-token" for request in requests)


def test_only_opted_in_services_with_named_ports_and_ready_slices_are_candidates():
    def service(name, **spec):
        return {"metadata": {"name": name, "labels": {"caipe.io/a2a-discovery": "true"}},
            "spec": {"ports": [{"name": "a2a-https", "port": 8443}], **spec}}
    ready, cold, external = service("ready"), service("cold"), service("external", type="ExternalName")
    unlabelled = service("unlabelled")
    unlabelled["metadata"]["labels"] = {}
    invalid = service("invalid")
    invalid["metadata"]["annotations"] = {"caipe.io/a2a-path": "//outside.example.test"}
    slices = [{"metadata": {"labels": {"kubernetes.io/service-name": "ready"}}, "endpoints": [{"conditions": {"ready": True}}]}]
    items = kubernetes.service_candidates([ready, cold, external, unlabelled, invalid], slices, "primary", "cluster.local")
    assert [(item["name"], item["ready"]) for item in items] == [("ready", True), ("cold", False)]
    assert items[0]["endpoint"] == "https://ready.primary.svc.cluster.local:8443"


async def test_kubernetes_resource_listing_paginates_and_preserves_selector():
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"items": [{"id": len(requests)}], "metadata": {"continue": "next" if len(requests) == 1 else ""}})
    async with httpx.AsyncClient(base_url="https://kubernetes.default.svc", transport=httpx.MockTransport(respond)) as client:
        items = await kubernetes._list_resources(client, "/api/v1/namespaces/primary/services", "caipe.io/a2a-discovery=true")
    assert len(items) == 2
    assert requests[1].url.params["continue"] == "next"
    assert all(r.url.params["labelSelector"] == "caipe.io/a2a-discovery=true" for r in requests)


async def test_kubernetes_permissions_failure_is_actionable_and_not_an_empty_success(monkeypatch):
    monkeypatch.setattr(remote_agents, "get_settings", lambda: SimpleNamespace(remote_a2a_discovery_namespaces=["primary"], remote_a2a_cluster_domain="cluster.local"))
    monkeypatch.setattr(remote_agents, "discover_services", AsyncMock(side_effect=httpx.ConnectError("unavailable")))
    with pytest.raises(HTTPException, match="read-only") as error:
        await remote_agents.discover_remote_agents(remote_agents.DiscoveryRequest(source="kubernetes", namespace="primary"), None)
    assert error.value.status_code == 502
