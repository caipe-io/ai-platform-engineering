"""Trusted existing-user matching, durable claims, and explicit-link fallback."""

from __future__ import annotations

import asyncio
import base64
import copy
from unittest.mock import AsyncMock

import httpx
import mongomock
import pytest

from ai_platform_engineering.integrations.webex_bot.utils import identity_linker as il
from ai_platform_engineering.integrations.webex_bot.utils import identity_write_lock as store
from ai_platform_engineering.integrations.webex_bot.utils import keycloak_admin as kc

PERSON = "person1234"
USER = {
    "id": "user-1",
    "enabled": True,
    "emailVerified": True,
    "email": "user@example.com",
    "attributes": {},
}
PROFILE = {"id": PERSON, "type": "person", "orgId": "org-primary", "emails": ["user@example.com"]}


@pytest.fixture
def setup(monkeypatch: pytest.MonkeyPatch) -> dict:
    monkeypatch.setenv("WEBEX_DM_AUTO_LINK_ENABLED", "true")
    monkeypatch.setenv("WEBEX_DM_AUTO_LINK_ALLOWED_ORG_ID", "org-primary")
    monkeypatch.setenv("MONGODB_URI", "mongodb://example.test")
    monkeypatch.setenv("KEYCLOAK_REALM", "example")
    collection = mongomock.MongoClient().example.webex_identity_operations
    monkeypatch.setattr(store, "identity_lock_collection", lambda: collection.database.webex_identity_write_locks)
    monkeypatch.setattr(store, "identity_binding_collection", lambda: collection)
    monkeypatch.setattr(il, "identity_binding_collection", lambda: collection)
    user = copy.deepcopy(USER)
    profile = copy.deepcopy(PROFILE)
    provider = AsyncMock(return_value=profile)
    lookup = AsyncMock(return_value=user)
    by_id = AsyncMock(side_effect=lambda _: copy.deepcopy(user))

    async def merge(_: str, attrs: dict) -> None:
        user["attributes"].update(attrs)

    write = AsyncMock(side_effect=merge)
    owners = AsyncMock(
        side_effect=lambda _: [user["id"]] if user["attributes"].get("webex_user_id") else []
    )
    monkeypatch.setattr(il, "_provider_profile", provider)
    monkeypatch.setattr(il, "get_unique_verified_user_by_email", lookup)
    monkeypatch.setattr(il, "get_user_by_id", by_id)
    monkeypatch.setattr(il, "merge_user_attributes", write)
    monkeypatch.setattr(il, "webex_identity_owners", owners)
    events = []
    monkeypatch.setattr(il, "log_webex_authz_decision", lambda **event: events.append(event))
    return dict(
        collection=collection,
        user=user,
        profile=profile,
        provider=provider,
        lookup=lookup,
        by_id=by_id,
        write=write,
        owners=owners,
        events=events,
    )


def run() -> il.AutoLinkResult:
    return asyncio.run(il._auto_link_webex_user(PERSON, "secondary"))


def test_disabled_by_default(setup: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBEX_DM_AUTO_LINK_ENABLED")
    assert run().outcome == "disabled"
    setup["provider"].assert_not_called()


@pytest.mark.parametrize(
    "missing,status",
    [("WEBEX_DM_AUTO_LINK_ALLOWED_ORG_ID", "missing_allowed_org"), ("MONGODB_URI", "missing_storage")],
)
def test_missing_trust_configuration(
    setup: dict, monkeypatch: pytest.MonkeyPatch, missing: str, status: str
) -> None:
    monkeypatch.delenv(missing)
    assert not il.webex_auto_link_status()["configured"]
    assert run().user_id is None
    setup["write"].assert_not_called()


def test_existing_user_link_updates_only_existing_routes(setup: dict) -> None:
    routes = setup["collection"].database.webex_direct_user_routes
    routes.insert_one(
        {"keycloak_user_id": "user-1", "status": "disabled", "agent_id": "agent-primary"}
    )
    routes.insert_one({"keycloak_user_id": "user-2", "status": "active"})
    result = run()
    assert result == il.AutoLinkResult("user-1", True, "linked")
    assert setup["lookup"].await_count == 2
    setup["lookup"].assert_awaited_with("user@example.com")
    assert routes.find_one({"keycloak_user_id": "user-1"})["webex_user_id"] == PERSON
    assert routes.find_one({"keycloak_user_id": "user-1"})["status"] == "disabled"
    assert "webex_user_id" not in routes.find_one({"keycloak_user_id": "user-2"})
    assert setup["user"]["attributes"]["webex_link_method"] == ["provider_email"]
    assert setup["events"][0]["resource_ref"] == "linked"
    assert "user@example.com" not in str(setup["events"])


@pytest.mark.parametrize(
    "patch,outcome",
    [
        ({"id": "someone-else"}, "untrusted_profile"),
        ({"type": "bot"}, "untrusted_profile"),
        ({"orgId": "other-org"}, "disallowed_org"),
        ({"orgId": None}, "disallowed_org"),
        ({"emails": []}, "untrusted_email"),
        ({"emails": ["user@example.com", "other@example.com"]}, "untrusted_email"),
        ({"emails": ["invalid"]}, "untrusted_email"),
    ],
)
def test_untrusted_provider_data(setup: dict, patch: dict, outcome: str) -> None:
    setup["profile"].update(patch)
    assert run().outcome == outcome
    setup["write"].assert_not_called()


def test_encoded_organization_and_email_normalization(setup: dict) -> None:
    setup["profile"]["orgId"] = (
        base64.b64encode(b"ciscospark://us/ORGANIZATION/org-primary").decode().rstrip("=")
    )
    setup["profile"]["emails"] = [" USER@EXAMPLE.COM "]
    assert run().created


@pytest.mark.parametrize(
    "patch,outcome",
    [
        ({"enabled": False}, "untrusted_identity"),
        ({"emailVerified": False}, "untrusted_identity"),
        ({"attributes": {"webex_user_id": ["other-person"]}}, "conflicting_binding"),
        ({"attributes": {"webex_auto_link_disabled": ["true"]}}, "unlinked"),
    ],
)
def test_ineligible_identity(setup: dict, patch: dict, outcome: str) -> None:
    setup["user"].update(patch)
    assert run().outcome == outcome
    setup["write"].assert_not_called()


def test_absent_or_ambiguous_match(setup: dict) -> None:
    setup["lookup"].return_value = None
    assert run().outcome == "no_unique_match"
    setup["write"].assert_not_called()


@pytest.mark.parametrize("owners", [["user-2"], ["user-1", "user-2"], ["user-1", "user-1"]])
def test_conflicting_person_binding(setup: dict, owners: list[str]) -> None:
    setup["owners"].side_effect = None
    setup["owners"].return_value = owners
    assert run().outcome == "conflicting_binding"
    setup["write"].assert_not_called()


def test_unlinked_person_stays_blocked_even_if_email_changes(setup: dict) -> None:
    setup["collection"].insert_one({"_id": store.identity_key("blocked", PERSON)})
    assert run().outcome == "unlinked"
    setup["write"].assert_not_called()


def test_concurrent_retries_claim_once(setup: dict) -> None:
    async def concurrent() -> list[il.AutoLinkResult]:
        return await asyncio.gather(
            *(il._auto_link_webex_user(PERSON, "secondary") for _ in range(4))
        )

    results = asyncio.run(concurrent())
    assert all(result.user_id == "user-1" for result in results)
    assert sum(result.created for result in results) == 1
    setup["write"].assert_awaited_once()
    assert setup["collection"].database.webex_identity_write_locks.count_documents({"_id": "identity-write"}) == 0


def test_uncertain_write_retains_lock_and_falls_back(setup: dict) -> None:
    setup["write"].side_effect = httpx.ReadTimeout("unavailable")
    assert run().outcome == "unavailable"
    assert setup["collection"].database.webex_identity_write_locks.find_one({"_id": "identity-write"}) is not None


def test_directory_recheck_rejects_disabled_user(setup: dict) -> None:
    setup["by_id"].side_effect = None
    setup["by_id"].return_value = {**USER, "enabled": False}
    assert run().outcome == "disabled_identity"
    setup["write"].assert_not_called()


def test_provider_fetch_uses_selected_bot_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SECONDARY_TOKEN", "test-provider-token")
    requests = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=PROFILE)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(il.httpx, "AsyncClient", lambda **_: client)
    assert asyncio.run(il._provider_profile(PERSON, "secondary")) == PROFILE
    assert str(requests[0].url) == f"https://webexapis.com/v1/people/{PERSON}"
    assert requests[0].headers["Authorization"] == "Bearer test-provider-token"


@pytest.mark.parametrize(
    "users", [[], [USER, {**USER, "id": "user-2"}], [{**USER, "email": "other@example.com"}]]
)
def test_unique_directory_lookup_rejects_absent_ambiguous_and_inexact(
    monkeypatch: pytest.MonkeyPatch, users: list
) -> None:
    monkeypatch.setattr(kc, "_get_admin_token", AsyncMock(return_value="test-admin-token"))

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["exact"] == "true"
        assert request.url.params["email"] == "user@example.com"
        return httpx.Response(200, json=users)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(kc.httpx, "AsyncClient", lambda **_: client)
    assert asyncio.run(kc.get_unique_verified_user_by_email("user@example.com")) is None


def test_dispatch_reservation_is_atomic_across_concurrent_retries(setup: dict) -> None:
    async def reserve() -> list[bool]:
        return await asyncio.gather(
            *(store.reserve_dm_dispatch("primary", "message1234") for _ in range(5))
        )

    assert sum(asyncio.run(reserve())) == 1
    assert asyncio.run(store.reserve_dm_dispatch("secondary", "message1234")) is True


def test_resolution_rechecks_after_disable_or_unlink(monkeypatch: pytest.MonkeyPatch) -> None:
    lookup = AsyncMock(
        side_effect=[{"id": "user-1", "enabled": True}, {"id": "user-1", "enabled": False}, None]
    )
    monkeypatch.setattr(il, "get_user_by_attribute", lookup)
    assert asyncio.run(il.resolve_webex_user(PERSON)) == "user-1"
    assert asyncio.run(il.resolve_webex_user(PERSON)) is None
    assert asyncio.run(il.resolve_webex_user(PERSON)) is None
    assert lookup.await_count == 3


def test_durable_claim_rejects_other_owner_even_when_directory_search_lags(setup: dict) -> None:
    setup["collection"].insert_one(
        {"_id": store.identity_key("binding", PERSON), "user_id": "user-2"}
    )
    assert run().outcome == "conflicting_binding"
    setup["write"].assert_not_called()


def test_reciprocal_claim_rejects_another_person_for_same_account(setup: dict) -> None:
    setup["collection"].insert_one(
        {"_id": store.identity_key("account", "user-1"), "person_id": "person5678"}
    )
    assert run().outcome == "conflicting_binding"
    setup["write"].assert_not_called()


def test_lookup_outage_releases_mutex_for_explicit_fallback(setup: dict) -> None:
    setup["by_id"].side_effect = httpx.ConnectTimeout("unavailable")
    assert run().outcome == "lookup_unavailable"
    assert setup["collection"].database.webex_identity_write_locks.count_documents({}) == 0
    setup["write"].assert_not_called()


def test_match_becomes_ambiguous_before_claim(setup: dict) -> None:
    setup["lookup"].side_effect = [setup["user"], None]
    assert run().outcome == "no_unique_match"
    setup["write"].assert_not_called()


def test_unverified_write_retains_mutex_and_does_not_bind_routes(setup: dict) -> None:
    setup["write"].side_effect = None
    setup["write"].return_value = None
    routes = setup["collection"].database.webex_direct_user_routes
    routes.insert_one({"keycloak_user_id": "user-1", "status": "active"})
    assert run().outcome == "unavailable"
    assert setup["collection"].database.webex_identity_write_locks.count_documents({}) == 1
    assert "webex_user_id" not in routes.find_one({"keycloak_user_id": "user-1"})


def test_duplicate_legacy_bindings_are_not_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kc, "_get_admin_token", AsyncMock(return_value="example-token"))
    users = [
        {"id": "primary", "attributes": {"webex_user_id": ["other-person", PERSON]}},
        {"id": "secondary", "attributes": {"webex_user_id": [PERSON]}},
    ]
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=users)))
    monkeypatch.setattr(kc.httpx, "AsyncClient", lambda **_: client)
    assert asyncio.run(kc.get_user_by_attribute("webex_user_id", PERSON)) is None
