"""Trust boundaries and persisted-state behavior for optional DM auto-linking."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from types import SimpleNamespace
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock

import mongomock
import pytest
from pymongo.errors import DuplicateKeyError

from ai_platform_engineering.integrations.webex_bot.utils import identity_linker as il
from ai_platform_engineering.integrations.webex_bot.utils import identity_write_lock as locks
from ai_platform_engineering.integrations.webex_bot.utils import keycloak_admin as ka


@pytest.fixture
def setup_auto(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    monkeypatch.setenv("WEBEX_DM_AUTO_LINK_ENABLED", "true")
    monkeypatch.setenv("WEBEX_DM_AUTO_LINK_ALLOWED_ORG_ID", "example-org")
    monkeypatch.setenv("MONGODB_URI", "mongodb://example.test")
    monkeypatch.setenv("EXAMPLE_BOT_TOKEN", "example-token")
    profile = {"id": "person1234", "type": "person", "orgId": "example-org", "emails": ["test-user@example.test"]}
    user: dict[str, Any] = {"id": "primary", "enabled": True, "emailVerified": True, "email": "test-user@example.test", "attributes": {}}
    state = SimpleNamespace(profile=profile, user=user, posts=[], existing=None, writes=[], collection=mongomock.MongoClient().example.webex_identity_bindings)

    class Client:
        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def get(self, url: str, **kwargs: Any) -> Any:
            assert url == "https://webexapis.com/v1/people/person1234"
            assert kwargs["headers"]["Authorization"] == "Bearer example-token"
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: deepcopy(state.profile))

        async def post(self, _url: str, **kwargs: Any) -> Any:
            state.posts.append(kwargs["json"])
            return SimpleNamespace(raise_for_status=lambda: None)

    @asynccontextmanager
    async def lock() -> AsyncIterator[None]:
        yield

    async def write(owner: str, attributes: dict[str, list[str]]) -> None:
        state.writes.append((owner, "webex_user_id", attributes["webex_user_id"][0]))
        state.user["attributes"].update(attributes)

    monkeypatch.setattr(il.httpx, "AsyncClient", lambda **_kwargs: Client())
    monkeypatch.setattr(il, "configured_webex_bot", lambda _id: SimpleNamespace(token_env="EXAMPLE_BOT_TOKEN", direct_messages_access_mode="all_users"))
    monkeypatch.setattr(il, "webex_identity_write_lock", lock)
    monkeypatch.setattr(il, "get_user_by_attribute", AsyncMock(side_effect=lambda *_args: state.existing))
    monkeypatch.setattr(il, "get_unique_verified_user_by_email", AsyncMock(side_effect=lambda _email: state.user))
    monkeypatch.setattr(il, "get_user_by_id", AsyncMock(side_effect=lambda _id: state.user))
    monkeypatch.setattr(il, "merge_user_attributes", write)
    monkeypatch.setattr(il, "identity_binding_collection", lambda: state.collection)
    monkeypatch.setattr(il, "webex_identity_owners", AsyncMock(side_effect=lambda *_args: [state.existing["id"]] if state.existing else []))
    monkeypatch.setattr(il, "log_webex_authz_decision", lambda **_kwargs: None)
    return state


def test_success_persists_identity_and_acknowledges_without_account_creation(setup_auto: SimpleNamespace) -> None:
    assert asyncio.run(il.auto_link_webex_user("person1234", "primary")) == "primary"
    assert setup_auto.writes == [("primary", "webex_user_id", "person1234")]
    assert setup_auto.posts[0]["toPersonId"] == "person1234"


@pytest.mark.parametrize("field,value", [("id", "other1234"), ("type", "bot"), ("orgId", "other-org"), ("emails", []), ("emails", ["a@example.test", "b@example.test"])])
def test_untrusted_provider_profile_falls_back(setup_auto: SimpleNamespace, field: str, value: Any) -> None:
    setup_auto.profile[field] = value
    assert asyncio.run(il.auto_link_webex_user("person1234", "primary")) is None
    assert setup_auto.writes == []


def test_missing_or_ambiguous_existing_user_falls_back(setup_auto: SimpleNamespace) -> None:
    setup_auto.user = None
    assert asyncio.run(il.auto_link_webex_user("person1234", "primary")) is None
    assert setup_auto.writes == []


@pytest.mark.parametrize("attributes", [{"webex_user_id": ["other1234"]}, {"webex_auto_link_disabled": ["true"]}])
def test_conflicts_and_explicit_unlink_optout_are_preserved(setup_auto: SimpleNamespace, attributes: dict[str, list[str]]) -> None:
    setup_auto.user["attributes"] = attributes
    assert asyncio.run(il.auto_link_webex_user("person1234", "primary")) is None
    assert setup_auto.writes == []


def test_another_owners_binding_is_not_overwritten(setup_auto: SimpleNamespace) -> None:
    setup_auto.existing = {"id": "secondary", "enabled": True}
    assert asyncio.run(il.auto_link_webex_user("person1234", "primary")) is None
    assert setup_auto.writes == []


def test_concurrent_completed_claim_is_reused_without_duplicate_ack(setup_auto: SimpleNamespace) -> None:
    setup_auto.user["attributes"]["webex_user_id"] = ["person1234"]
    setup_auto.existing = setup_auto.user
    assert asyncio.run(il.auto_link_webex_user("person1234", "primary")) == "primary"
    assert setup_auto.writes == []
    assert setup_auto.posts == []


def test_disabled_policy_does_no_provider_work(setup_auto: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBEX_DM_AUTO_LINK_ENABLED", "false")
    assert asyncio.run(il.auto_link_webex_user("person1234", "primary")) is None
    assert setup_auto.writes == []


def test_lock_contention_cannot_run_second_writer(monkeypatch: pytest.MonkeyPatch) -> None:
    documents: dict[str, Any] = {}

    class Collection:
        def insert_one(self, document: dict[str, Any]) -> None:
            if documents:
                raise DuplicateKeyError("busy")
            documents.update(document)

        def delete_one(self, query: dict[str, Any]) -> None:
            assert query["nonce"] == documents["nonce"]
            documents.clear()

    monkeypatch.setattr(locks, "identity_lock_collection", lambda: Collection())

    async def scenario() -> None:
        async with locks.webex_identity_write_lock():
            with pytest.raises(DuplicateKeyError):
                async with locks.webex_identity_write_lock():
                    pytest.fail("Second writer entered a held lock")
        assert not documents

    asyncio.run(scenario())


@pytest.mark.parametrize("users,expected", [
    ([], None),
    ([{"id": "primary", "enabled": True, "emailVerified": True, "email": "test-user@example.test"}], "primary"),
    ([{"id": "primary", "enabled": False, "emailVerified": True, "email": "test-user@example.test"}], None),
    ([{"id": "primary", "enabled": True, "emailVerified": False, "email": "test-user@example.test"}], None),
    ([{"id": "primary", "enabled": True, "emailVerified": True, "email": "other@example.test"}], None),
    ([{"id": "primary"}, {"id": "secondary"}], None),
])
def test_exact_match_requires_one_verified_enabled_account(monkeypatch: pytest.MonkeyPatch, users: list[dict[str, Any]], expected: str | None) -> None:
    class Client:
        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def get(self, _url: str, **kwargs: Any) -> Any:
            assert kwargs["params"] == {"email": "test-user@example.test", "exact": "true", "max": 2}
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: users)

    monkeypatch.setattr(ka, "_get_admin_token", AsyncMock(return_value="example-token"))
    monkeypatch.setattr(ka.httpx, "AsyncClient", lambda **_kwargs: Client())
    result = asyncio.run(ka.get_unique_verified_user_by_email("test-user@example.test"))
    assert (result or {}).get("id") == expected
