"""Renew owner OBO credentials only for a currently admitted Engine run."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any

import httpx

from harness_engine.coding.admission import ClosedBindingFence, CodingAdmissionError, ConversationFence, RunFence
from harness_engine.coding.config import service_url
from harness_engine.config import Settings


class AuthorizedRunCredentials:
    """Reuse platform token exchange and CAS, without trusting a sandbox subject.

    A scoped confidential client must be configured by the operator. Each use
    checks the current Engine lease, saved visible conversation and agent, then
    repeats CAS agent/use under a real owner bearer. This is not a general
    impersonation endpoint and does not store refresh credentials in run state.
    """

    def __init__(
        self, settings: Settings, fence: RunFence | ConversationFence | ClosedBindingFence, *, client: Any | None = None
    ) -> None:
        self.settings, self.fence, self.client = settings, fence, client
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()
        self._endpoint = service_url(settings.coding_obo_token_url)
        self._platform = service_url(settings.coding_platform_url)
        if not settings.coding_obo_client_id or not settings.coding_obo_client_secret:
            raise CodingAdmissionError("An operator-scoped owner token-exchange client is required")

    async def _post(self, url: str, **kwargs: Any) -> Any:
        if self.client is not None:
            return await self.client.post(url, **kwargs)
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            return await client.post(url, **kwargs)

    async def _mint(self) -> None:
        response = await self._post(
            self._endpoint,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "requested_subject": self.fence.context.binding.owner_subject,
                "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "client_id": self.settings.coding_obo_client_id,
                "client_secret": self.settings.coding_obo_client_secret,
                "audience": self.settings.coding_obo_audience,
            },
        )
        if response.status_code != 200:
            raise CodingAdmissionError("Owner token renewal was rejected")
        data = response.json()
        token, lifetime = data.get("access_token"), data.get("expires_in")
        if not isinstance(token, str) or not token or type(lifetime) is not int or lifetime <= 30:
            raise CodingAdmissionError("Owner token renewal returned invalid credentials")
        self._token, self._expires_at = token, time.monotonic() + min(lifetime - 30, 270)

    def _subject(self) -> dict[str, str]:
        try:
            payload = (self._token or "").split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            if claims.get("sub") != self.fence.context.binding.owner_subject:
                raise ValueError
            kind = (
                "service_account"
                if str(claims.get("preferred_username", "")).startswith("service-account-")
                else "user"
            )
            return {"type": kind, "id": claims["sub"]}
        except (IndexError, ValueError, TypeError):
            raise CodingAdmissionError("Owner token renewal changed the admitted subject") from None

    async def token(self, *, agent_id: str | None = None, allow_cancelled: bool = False) -> str:
        await self.fence.require(allow_cancelled=allow_cancelled)
        async with self._lock:
            if self._token is None or self._expires_at <= time.monotonic():
                try:
                    await self._mint()
                except (httpx.HTTPError, ValueError):
                    raise CodingAdmissionError("Owner token renewal is unavailable") from None
            subject = self._subject()
            try:
                response = await self._post(
                    self._platform + "/api/authz/v1/decisions",
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "subject": subject,
                        "resource": {"type": "agent", "id": agent_id or self.fence.context.binding.agent_id},
                        "action": "use",
                    },
                )
                if response.status_code != 200 or response.json().get("decision") != "ALLOW":
                    raise CodingAdmissionError("Current agent access does not authorize this operation")
            except (httpx.HTTPError, ValueError):
                raise CodingAdmissionError("Current agent authorization is unavailable") from None
            await self.fence.require(allow_cancelled=allow_cancelled)
            assert self._token is not None
            return self._token

    async def authorize_resource(self, resource_type: str, resource_id: str, action: str) -> str:
        bearer = await self.token()
        try:
            response = await self._post(
                self._platform + "/api/authz/v1/decisions",
                headers={"Authorization": "Bearer " + bearer, "Content-Type": "application/json"},
                json={
                    "subject": self._subject(),
                    "resource": {"type": resource_type, "id": resource_id},
                    "action": action,
                },
            )
            if response.status_code != 200 or response.json().get("decision") != "ALLOW":
                raise CodingAdmissionError("Current resource authorization does not admit this operation")
        except (httpx.HTTPError, ValueError):
            raise CodingAdmissionError("Current resource authorization is unavailable") from None
        await self.fence.require()
        return bearer
