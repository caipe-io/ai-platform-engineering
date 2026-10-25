"""Client for CAIPE's server-side credential API."""

from collections.abc import Callable
from typing import Any

import httpx


class CredentialExchangeClient:
    """Retrieve credential material from the CAIPE credential service.

    The client is intended for server-side Dynamic Agents only. It sends the
    service caller headers required by the UI credential API and never forwards
    browser cookies or fetch metadata.
    """

    def __init__(
        self,
        *,
        base_url: str,
        audience: str,
        http_client: httpx.AsyncClient | Any | None = None,
        token_provider: Callable[[], str],
        trusted_interaction: dict[str, str] | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._audience = audience
        self._http_client = http_client
        self._token_provider = token_provider
        self._trusted_interaction = trusted_interaction or {}

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._token_provider()}",
            "x-caipe-credential-caller": "dynamic_agent",
            "x-caipe-credential-audience": self._audience,
        }
        token = self._trusted_interaction.get("token", "")
        signature = self._trusted_interaction.get("signature", "")
        if token and signature:
            headers["x-caipe-trusted-interaction"] = token
            headers["x-caipe-trusted-interaction-signature"] = signature
        return headers

    async def retrieve_secret(self, secret_ref: str, *, intended_use: str) -> str:
        """Retrieve a BYO secret by reference for MCP/runtime use."""

        data = await self._post(
            "/retrieve",
            {"secret_ref": secret_ref, "intended_use": intended_use},
        )
        credential = data.get("credential")
        if not isinstance(credential, str):
            raise ValueError("credential service response did not include credential")
        return credential

    async def exchange_provider_connection(
        self,
        provider_connection_id: str,
        *,
        intended_use: str,
        mcp_server_id: str | None = None,
    ) -> dict[str, Any]:
        """Exchange a provider connection for a server-side provider credential."""

        payload: dict[str, Any] = {
            "provider_connection_id": provider_connection_id,
            "intended_use": intended_use,
        }
        if mcp_server_id:
            payload["mcp_server_id"] = mcp_server_id
        return await self._post("/exchange", payload)

    async def exchange_provider_connection_by_provider(
        self,
        provider: str,
        *,
        intended_use: str,
        mcp_server_id: str | None = None,
    ) -> dict[str, Any]:
        """Exchange the current JWT subject's provider connection by provider key."""

        payload: dict[str, Any] = {
            "provider": provider,
            "intended_use": intended_use,
        }
        if mcp_server_id:
            payload["mcp_server_id"] = mcp_server_id
        return await self._post("/exchange", payload)

    async def _post(self, path: str, json_body: dict[str, Any]) -> dict[str, Any]:
        client = self._http_client
        if client is not None:
            response = await client.post(f"{self._base_url}{path}", json=json_body, headers=self._headers())
            response.raise_for_status()
            payload = response.json()
            return payload.get("data", payload)

        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as owned_client:
            response = await owned_client.post(f"{self._base_url}{path}", json=json_body, headers=self._headers())
            response.raise_for_status()
            payload = response.json()
            return payload.get("data", payload)
