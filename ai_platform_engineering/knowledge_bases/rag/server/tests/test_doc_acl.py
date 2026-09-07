"""Tests for the hybrid-ACL helper (server.doc_acl).

These tests exercise the feature flag, tag derivation, and the
filter merge semantics — including the failure-closed behaviour
that prevents callers from widening their own ACL.
"""

from __future__ import annotations

import importlib

import pytest

from common.models.rbac import UserContext
from common.models.server import QueryRequest


def _reload_with_flag(value: str):
    """Reload server.doc_acl with RBAC_DOC_ACL_TAGS_ENABLED=<value>."""
    import os

    os.environ["RBAC_DOC_ACL_TAGS_ENABLED"] = value
    import server.doc_acl as mod

    return importlib.reload(mod)


@pytest.fixture(autouse=True)
def _restore_flag(monkeypatch):
    """Reset the env var + reload after each test so flag state never leaks."""
    yield
    monkeypatch.delenv("RBAC_DOC_ACL_TAGS_ENABLED", raising=False)
    import server.doc_acl as mod

    importlib.reload(mod)


def _user(
    email: str = "alice@example.com",
) -> UserContext:
    return UserContext(
        email=email,
        role="user",
        is_authenticated=True,
    )


def _qr(filters=None) -> QueryRequest:
    return QueryRequest(query="anything", filters=filters or {})


# ---------------------------------------------------------------------------
# derive_user_acl_tags
# ---------------------------------------------------------------------------


def test_derive_returns_empty_when_flag_off():
    mod = _reload_with_flag("false")
    tags = mod.derive_user_acl_tags(_user())
    assert tags == []


def test_derive_includes_only_public_for_authenticated_users():
    mod = _reload_with_flag("true")
    tags = mod.derive_user_acl_tags(_user())
    assert tags == [mod.PUBLIC_TAG]


def test_user_context_does_not_carry_group_or_realm_role_tags():
    mod = _reload_with_flag("true")
    user = _user()
    assert not hasattr(user, "groups")
    assert not hasattr(user, "realm_roles")
    tags = mod.derive_user_acl_tags(user)
    assert tags == [mod.PUBLIC_TAG]


# ---------------------------------------------------------------------------
# apply_doc_acl_filter — flag off / bypass principals
# ---------------------------------------------------------------------------


def test_apply_noop_when_flag_off():
    mod = _reload_with_flag("false")
    qr = _qr()
    mod.apply_doc_acl_filter(qr, _user())
    assert qr.filters == {}


def test_apply_filters_client_credentials_principal_too():
    mod = _reload_with_flag("true")
    qr = _qr()
    mod.apply_doc_acl_filter(qr, _user(email="client:rag-ingestor"))
    assert qr.filters[mod.ACL_FILTER_KEY] == [mod.PUBLIC_TAG]


# ---------------------------------------------------------------------------
# apply_doc_acl_filter — merge semantics
# ---------------------------------------------------------------------------


def test_apply_sets_filter_when_absent():
    mod = _reload_with_flag("true")
    qr = _qr()
    mod.apply_doc_acl_filter(qr, _user())
    tags = qr.filters[mod.ACL_FILTER_KEY]
    assert tags == [mod.PUBLIC_TAG]


def test_apply_keeps_public_string_when_in_user_set():
    mod = _reload_with_flag("true")
    qr = _qr(filters={mod.ACL_FILTER_KEY: mod.PUBLIC_TAG})
    mod.apply_doc_acl_filter(qr, _user())
    assert qr.filters[mod.ACL_FILTER_KEY] == [mod.PUBLIC_TAG]


def test_apply_drops_existing_string_outside_user_set():
    mod = _reload_with_flag("true")
    qr = _qr(filters={mod.ACL_FILTER_KEY: "team:secret-ops"})
    mod.apply_doc_acl_filter(qr, _user())
    # caller cannot widen — "__noresults__" guarantees zero rows
    assert qr.filters[mod.ACL_FILTER_KEY] == ["__noresults__"]


def test_apply_intersects_existing_list_with_user_set():
    mod = _reload_with_flag("true")
    qr = _qr(
        filters={
            mod.ACL_FILTER_KEY: [mod.PUBLIC_TAG, "team:secret-ops"]
        }
    )
    mod.apply_doc_acl_filter(qr, _user())
    assert qr.filters[mod.ACL_FILTER_KEY] == [mod.PUBLIC_TAG]


def test_apply_empty_intersection_yields_noresults_sentinel():
    mod = _reload_with_flag("true")
    qr = _qr(filters={mod.ACL_FILTER_KEY: ["team:secret-ops"]})
    mod.apply_doc_acl_filter(qr, _user())
    assert qr.filters[mod.ACL_FILTER_KEY] == ["__noresults__"]


def test_apply_unexpected_type_fails_closed():
    mod = _reload_with_flag("true")
    qr = _qr()
    # Bypass pydantic validation — simulate a buggy upstream that
    # somehow planted a non-string/list value into filters.
    object.__setattr__(qr, "filters", {mod.ACL_FILTER_KEY: 42})
    mod.apply_doc_acl_filter(qr, _user())
    assert qr.filters[mod.ACL_FILTER_KEY] == ["__noresults__"]


def test_apply_preserves_unrelated_filters():
    mod = _reload_with_flag("true")
    qr = _qr(filters={"datasource_id": "team-eng-kb", "document_type": "doc"})
    mod.apply_doc_acl_filter(qr, _user())
    assert qr.filters["datasource_id"] == "team-eng-kb"
    assert qr.filters["document_type"] == "doc"
    assert mod.ACL_FILTER_KEY in qr.filters
