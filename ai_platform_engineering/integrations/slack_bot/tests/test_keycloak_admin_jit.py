# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the slack-bot ``keycloak_admin`` BFF client.

Every Keycloak operation in this module now flows through a first-party CAIPE
BFF endpoint carrying the bot's service-account token (issue #1781 moved JIT
create; the
``2026-06-09-slack-bot-remove-direct-keycloak-admin`` spec moved the lookups
and attribute writes). The bot holds no Keycloak Admin credentials of its own.

These tests pin:

* ``create_user_from_slack`` → ``POST /api/admin/users/provision-shell`` —
  the request (URL, ``X-Client-Source: slack-bot`` header, SA bearer token,
  ``{email, source, attributes:{slack_user_id}}`` body), the HTTP-status →
  typed ``JitError`` mapping (401→auth, 403→forbidden, 5xx/unexpected→server,
  network→network) keyed off ``error_kind`` (FR-011), the happy path returning
  the envelope ``sub`` for created and existing users, and the unconfigured-BFF
  → ``JitNetworkError`` fallback.
* ``get_user_by_attribute`` / ``get_user_by_email`` / ``get_user_attribute``
  → ``GET /api/admin/users/resolve`` — URL, headers, query params, envelope
  parsing (``sub``→``id``), and ``None`` on a ``data: null`` miss.
* ``set_user_attribute`` → ``PATCH /api/admin/users/{id}/attributes`` — URL,
  headers, and the ``{attributes: {attr: [value]}}`` merge body.

Mocking strategy: we monkeypatch ``httpx.AsyncClient`` inside
``keycloak_admin`` to a fake async-context-manager that records calls and
returns scripted responses, and stub ``bff_client`` helpers so no real token
or env is needed.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from ai_platform_engineering.integrations.slack_bot.utils import (
    keycloak_admin as ka,
)


# --------------------------------------------------------------------------- #
# Test scaffolding                                                            #
# --------------------------------------------------------------------------- #


class _FakeResponse:
    def __init__(
        self,
        status_code: int = 200,
        json_data: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}
        self.headers = headers or {}

    def json(self) -> Any:
        if isinstance(self._json, BaseException):
            raise self._json
        return self._json

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=None,  # type: ignore[arg-type]
                response=None,  # type: ignore[arg-type]
            )


class _FakeAsyncClient:
    """Async-context-manager stub for ``httpx.AsyncClient``.

    ``script`` is a list of ``(predicate, response_or_exception)`` tuples.
    The first predicate that matches a method+url combo wins. Predicates are
    simple callables: ``f(method, url, **kwargs) -> bool``.
    """

    def __init__(self, script: list[tuple], calls: list[dict]) -> None:
        self._script = script
        self._calls = calls

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def _dispatch(self, method: str, url: str, **kwargs: Any) -> _FakeResponse:
        self._calls.append({"method": method, "url": url, **kwargs})
        for predicate, payload in self._script:
            if predicate(method, url, **kwargs):
                if isinstance(payload, BaseException):
                    raise payload
                return payload
        raise AssertionError(
            f"No scripted response for {method} {url} (kwargs={list(kwargs)})"
        )

    async def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        return await self._dispatch("POST", url, **kwargs)

    async def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        return await self._dispatch("GET", url, **kwargs)

    async def put(self, url: str, **kwargs: Any) -> _FakeResponse:
        return await self._dispatch("PUT", url, **kwargs)

    async def patch(self, url: str, **kwargs: Any) -> _FakeResponse:
        return await self._dispatch("PATCH", url, **kwargs)


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch):
    """Return a function that installs a fake httpx.AsyncClient.

    Usage::

        calls = install_fake([(predicate, response_or_exc)])
    """
    calls: list[dict] = []

    def _install(script: list[tuple]) -> list[dict]:
        def _factory(*args: Any, **kwargs: Any) -> _FakeAsyncClient:
            return _FakeAsyncClient(script, calls)

        monkeypatch.setattr(ka.httpx, "AsyncClient", _factory)
        return calls

    return _install


@pytest.fixture(autouse=True)
def _bff_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub the BFF base URL + service-account token so create_user_from_slack
    has somewhere to call and a token to send, without touching real env/OAuth."""
    monkeypatch.setattr(ka, "resolve_bff_base_url", lambda *a, **k: "http://ui.test:3000")
    monkeypatch.setattr(ka, "service_account_token", lambda: "sa-token")


def _is_provision(method: str, url: str, **_: Any) -> bool:
    return method == "POST" and url.endswith("/api/admin/users/provision-shell")


def _ok(sub: str = "kc-uuid", created: bool = True) -> _FakeResponse:
    return _FakeResponse(200, {"success": True, "data": {"sub": sub, "created": created}})


# --------------------------------------------------------------------------- #
# Request shape — URL, headers, body                                          #
# --------------------------------------------------------------------------- #


def test_create_user_from_slack_calls_bff_with_pinned_request(fake_client) -> None:
    """The bot MUST call the BFF provision-shell endpoint with a lowercased
    email, the ``slack-bot:jit`` source, the slack_user_id attribute, the
    service-account bearer token, and the X-Client-Source header."""
    calls = fake_client([(_is_provision, _ok(sub="abc-uuid", created=True))])

    new_id = asyncio.run(ka.create_user_from_slack("U123", "Alice@Corp.COM"))

    assert new_id == "abc-uuid"
    call = next(c for c in calls if _is_provision(c["method"], c["url"]))
    assert call["url"] == "http://ui.test:3000/api/admin/users/provision-shell"

    body = call.get("json")
    assert body == {
        "email": "alice@corp.com",
        "source": "slack-bot:jit",
        "attributes": {"slack_user_id": ["U123"]},
    }, "email must be lowercased; source + slack_user_id attribute pinned"

    headers = call.get("headers", {})
    assert headers.get("X-Client-Source") == "slack-bot"
    assert headers.get("Authorization") == "Bearer sa-token"
    assert headers.get("Content-Type") == "application/json"


def test_create_user_from_slack_returns_sub_for_existing_user(fake_client) -> None:
    """When the BFF resolves an existing user (created=false), the bot still
    returns the sub — idempotent create-or-resolve preserved."""
    fake_client([(_is_provision, _ok(sub="existing-uuid", created=False))])
    new_id = asyncio.run(ka.create_user_from_slack("U1", "bob@corp.com"))
    assert new_id == "existing-uuid"


# --------------------------------------------------------------------------- #
# Error paths — typed exceptions, stable error_kind                           #
# --------------------------------------------------------------------------- #


def test_jit_401_raises_jit_auth_error(fake_client) -> None:
    fake_client([(_is_provision, _FakeResponse(401))])
    with pytest.raises(ka.JitAuthError) as exc_info:
        asyncio.run(ka.create_user_from_slack("U1", "a@x.com"))
    assert exc_info.value.error_kind == "auth_failure"


def test_jit_403_raises_jit_forbidden_error(fake_client) -> None:
    """403 is the load-bearing signal that the bot SA lacks the provisioning
    grant. The error message must point at the OpenFGA fix."""
    fake_client([(_is_provision, _FakeResponse(403))])
    with pytest.raises(ka.JitForbiddenError) as exc_info:
        asyncio.run(ka.create_user_from_slack("U1", "a@x.com"))
    assert exc_info.value.error_kind == "forbidden"
    assert "admin_surface:user_provisioning" in str(exc_info.value)


def test_jit_5xx_raises_jit_server_error(fake_client) -> None:
    fake_client([(_is_provision, _FakeResponse(503))])
    with pytest.raises(ka.JitServerError) as exc_info:
        asyncio.run(ka.create_user_from_slack("U1", "a@x.com"))
    assert exc_info.value.error_kind == "server_error"


def test_jit_unexpected_status_raises_jit_server_error(fake_client) -> None:
    """A non-2xx, non-{401,403,5xx} status (e.g. 400 bad request) is a server
    error from the bot's perspective — it cannot proceed."""
    fake_client([(_is_provision, _FakeResponse(400))])
    with pytest.raises(ka.JitServerError):
        asyncio.run(ka.create_user_from_slack("U1", "a@x.com"))


def test_jit_network_error_raises_jit_network_error(fake_client) -> None:
    fake_client([(_is_provision, httpx.ConnectError("boom"))])
    with pytest.raises(ka.JitNetworkError) as exc_info:
        asyncio.run(ka.create_user_from_slack("U1", "a@x.com"))
    assert exc_info.value.error_kind == "network_error"


def test_jit_unconfigured_bff_raises_network_error(
    fake_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No BFF base URL configured ⇒ nowhere to provision. Surface as a
    network-class failure so the caller falls back to link-onboarding."""
    monkeypatch.setattr(ka, "resolve_bff_base_url", lambda *a, **k: "")
    # No HTTP should be attempted; an empty script asserts that.
    fake_client([])
    with pytest.raises(ka.JitNetworkError):
        asyncio.run(ka.create_user_from_slack("U1", "a@x.com"))


# --------------------------------------------------------------------------- #
# Malformed success envelope                                                  #
# --------------------------------------------------------------------------- #


def test_jit_2xx_without_sub_raises_server_error(fake_client) -> None:
    """A 200 whose envelope has no ``sub`` is a server-side inconsistency —
    better to fail loudly than to return a bogus id."""
    fake_client([(_is_provision, _FakeResponse(200, {"success": True, "data": {}}))])
    with pytest.raises(ka.JitServerError):
        asyncio.run(ka.create_user_from_slack("U1", "a@x.com"))


def test_jit_2xx_non_json_raises_server_error(fake_client) -> None:
    fake_client([(_is_provision, _FakeResponse(200, ValueError("not json")))])
    with pytest.raises(ka.JitServerError):
        asyncio.run(ka.create_user_from_slack("U1", "a@x.com"))


# --------------------------------------------------------------------------- #
# Lookups → GET /api/admin/users/resolve                                      #
# --------------------------------------------------------------------------- #


def _is_resolve(method: str, url: str, **_: Any) -> bool:
    return method == "GET" and url.endswith("/api/admin/users/resolve")


def _resolve_ok(
    sub: str = "kc-uuid",
    enabled: bool = True,
    attributes: dict[str, list[str]] | None = None,
) -> _FakeResponse:
    return _FakeResponse(
        200,
        {
            "success": True,
            "data": {
                "sub": sub,
                "enabled": enabled,
                "attributes": attributes or {},
            },
        },
    )


def _resolve_null() -> _FakeResponse:
    return _FakeResponse(200, {"success": True, "data": None})


def test_get_user_by_attribute_calls_resolve_and_maps_sub_to_id(fake_client) -> None:
    """``get_user_by_attribute`` MUST hit the resolve endpoint with the
    attribute+value query, send the SA bearer + X-Client-Source header, and
    map the envelope ``sub`` to ``id`` so callers (identity_linker) are
    untouched."""
    calls = fake_client(
        [(_is_resolve, _resolve_ok(sub="abc-uuid", attributes={"slack_user_id": ["U1"]}))]
    )

    user = asyncio.run(ka.get_user_by_attribute("slack_user_id", "U1"))

    assert user == {
        "id": "abc-uuid",
        "enabled": True,
        "attributes": {"slack_user_id": ["U1"]},
    }
    call = next(c for c in calls if _is_resolve(c["method"], c["url"]))
    assert call["url"] == "http://ui.test:3000/api/admin/users/resolve"
    assert call.get("params") == {"attribute": "slack_user_id", "value": "U1"}
    headers = call.get("headers", {})
    assert headers.get("X-Client-Source") == "slack-bot"
    assert headers.get("Authorization") == "Bearer sa-token"


def test_get_user_by_attribute_returns_none_on_null(fake_client) -> None:
    """A ``data: null`` miss MUST surface as ``None`` (the "not found"
    branch the callers rely on)."""
    fake_client([(_is_resolve, _resolve_null())])
    assert asyncio.run(ka.get_user_by_attribute("slack_user_id", "nope")) is None


def test_get_user_by_email_calls_resolve_with_email_param(fake_client) -> None:
    calls = fake_client([(_is_resolve, _resolve_ok(sub="email-uuid"))])

    user = asyncio.run(ka.get_user_by_email("alice@corp.com"))

    assert user is not None and user["id"] == "email-uuid"
    call = next(c for c in calls if _is_resolve(c["method"], c["url"]))
    assert call.get("params") == {"email": "alice@corp.com"}


def test_get_user_by_email_returns_none_on_null(fake_client) -> None:
    fake_client([(_is_resolve, _resolve_null())])
    assert asyncio.run(ka.get_user_by_email("missing@corp.com")) is None


def test_get_user_attribute_reads_first_value(fake_client) -> None:
    """``get_user_attribute`` resolves by id then returns the first value of
    the named attribute."""
    calls = fake_client(
        [(_is_resolve, _resolve_ok(sub="u", attributes={"caipe_default_team_id": ["platform"]}))]
    )

    value = asyncio.run(ka.get_user_attribute("u", "caipe_default_team_id"))

    assert value == "platform"
    call = next(c for c in calls if _is_resolve(c["method"], c["url"]))
    assert call.get("params") == {"id": "u"}


def test_get_user_attribute_returns_none_when_absent(fake_client) -> None:
    """Attribute not present on the resolved user ⇒ ``None``."""
    fake_client([(_is_resolve, _resolve_ok(sub="u", attributes={}))])
    assert asyncio.run(ka.get_user_attribute("u", "caipe_default_team_id")) is None


def test_get_user_attribute_returns_none_when_user_missing(fake_client) -> None:
    """No such user (``data: null``) ⇒ ``None``."""
    fake_client([(_is_resolve, _resolve_null())])
    assert asyncio.run(ka.get_user_attribute("ghost", "caipe_default_team_id")) is None


def test_resolve_raises_on_unexpected_status(fake_client) -> None:
    """A non-2xx from the resolve endpoint propagates (raise_for_status),
    preserving the old direct-Admin error semantics."""
    fake_client([(_is_resolve, _FakeResponse(500))])
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(ka.get_user_by_attribute("slack_user_id", "U1"))


# --------------------------------------------------------------------------- #
# set_user_attribute → PATCH /api/admin/users/{id}/attributes                 #
# --------------------------------------------------------------------------- #


def test_set_user_attribute_patches_bff_attributes_endpoint(fake_client) -> None:
    """``set_user_attribute`` MUST PATCH the per-user attributes endpoint with
    the ``{attributes: {attr: [value]}}`` merge body and the SA headers. The
    BFF (not the bot) now owns the Keycloak-26 user-profile round-trip."""
    user_id = "edd383d8-8344-4145-8b37-4c2e732001e8"

    def _is_patch_attrs(method: str, url: str, **_: Any) -> bool:
        return method == "PATCH" and url.endswith(
            f"/api/admin/users/{user_id}/attributes"
        )

    calls = fake_client([(_is_patch_attrs, _FakeResponse(200, {"success": True, "data": {"ok": True}}))])

    asyncio.run(ka.set_user_attribute(user_id, "slack_user_id", "U09TC6RR8KX"))

    call = next(c for c in calls if _is_patch_attrs(c["method"], c["url"]))
    assert call["url"] == f"http://ui.test:3000/api/admin/users/{user_id}/attributes"
    assert call.get("json") == {"attributes": {"slack_user_id": ["U09TC6RR8KX"]}}
    headers = call.get("headers", {})
    assert headers.get("X-Client-Source") == "slack-bot"
    assert headers.get("Authorization") == "Bearer sa-token"
    assert headers.get("Content-Type") == "application/json"


def test_set_user_attribute_raises_on_error_status(fake_client) -> None:
    """A non-2xx from the attributes endpoint propagates (raise_for_status)."""

    def _is_patch_attrs(method: str, url: str, **_: Any) -> bool:
        return method == "PATCH" and "/attributes" in url

    fake_client([(_is_patch_attrs, _FakeResponse(403))])
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(ka.set_user_attribute("u", "slack_user_id", "U1"))
