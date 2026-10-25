"""Tests for the Dynamic Agents credential exchange client."""

import pytest

from dynamic_agents.services.credential_exchange import CredentialExchangeClient


class FakeResponse:
    """Small httpx-like response test double."""

    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeAsyncClient:
    """Captures requests without performing network IO."""

    def __init__(self) -> None:
        self.requests = []

    async def post(self, url: str, **kwargs):
        self.requests.append((url, kwargs))
        return FakeResponse(
            200,
            {
                "success": True,
                "data": {
                    "secret_ref": "secret-1",
                    "credential": "github-token-value",
                },
            },
        )


@pytest.mark.asyncio
async def test_retrieve_secret_sends_service_headers_and_never_browser_headers():
    fake_client = FakeAsyncClient()
    client = CredentialExchangeClient(
        base_url="http://caipe-ui:3000/api/credentials",
        audience="caipe-credential-service",
        http_client=fake_client,
        token_provider=lambda: "service-token",
    )

    credential = await client.retrieve_secret("secret-1", intended_use="mcp_server")

    assert credential == "github-token-value"
    url, kwargs = fake_client.requests[0]
    assert url == "http://caipe-ui:3000/api/credentials/retrieve"
    assert kwargs["headers"] == {
        "Authorization": "Bearer service-token",
        "x-caipe-credential-caller": "dynamic_agent",
        "x-caipe-credential-audience": "caipe-credential-service",
    }
    assert kwargs["json"] == {"secret_ref": "secret-1", "intended_use": "mcp_server"}
    assert "Cookie" not in kwargs["headers"]


@pytest.mark.asyncio
async def test_exchange_provider_connection_uses_standard_exchange_endpoint():
    fake_client = FakeAsyncClient()
    client = CredentialExchangeClient(
        base_url="http://caipe-ui:3000/api/credentials/",
        audience="caipe-credential-service",
        http_client=fake_client,
        token_provider=lambda: "service-token",
    )

    await client.exchange_provider_connection("conn-1", intended_use="mcp_server")

    url, kwargs = fake_client.requests[0]
    assert url == "http://caipe-ui:3000/api/credentials/exchange"
    assert kwargs["json"] == {"provider_connection_id": "conn-1", "intended_use": "mcp_server"}


@pytest.mark.asyncio
async def test_retrieve_secret_forwards_trusted_interaction_proof():
    fake_client = FakeAsyncClient()
    client = CredentialExchangeClient(
        base_url="http://caipe-ui:3000/api/credentials",
        audience="caipe-credential-service",
        http_client=fake_client,
        token_provider=lambda: "user-token",
        trusted_interaction={"token": "signed-payload", "signature": "signed-hash"},
    )

    await client.retrieve_secret("secret-1", intended_use="mcp_server")

    _, kwargs = fake_client.requests[0]
    assert kwargs["headers"]["x-caipe-trusted-interaction"] == "signed-payload"
    assert kwargs["headers"]["x-caipe-trusted-interaction-signature"] == "signed-hash"
