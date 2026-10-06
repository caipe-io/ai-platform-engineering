"""Saved grants and current tool scopes use the same legacy wildcard semantics."""

from types import SimpleNamespace

import pytest

from dynamic_agents.services.mcp_client import filter_tools_by_allowed, intersect_allowed_tools, is_tool_scope_subset


@pytest.mark.parametrize("base,candidate,expected", [
    (True, True, True),
    (True, ["read"], True),
    (True, [], True),
    (False, False, True),
    (False, True, False),
    (False, [], False),
    (["read"], False, True),
    (["read"], True, False),
    (["read"], [], False),
    (["read", "write"], ["read"], True),
    (["read"], ["read", "write"], False),
    ([], True, True),
    ([], ["read"], True),
    ([], [], True),
])
def test_scope_subset_uses_the_native_filter_semantics(
    base: list[str] | bool, candidate: list[str] | bool, expected: bool,
) -> None:
    assert is_tool_scope_subset(base, candidate) is expected


@pytest.mark.parametrize("saved,current,expected", [
    (True, True, True),
    (True, ["read"], ["read"]),
    (["read"], True, ["read"]),
    (["read", "write"], ["read", "new"], ["read"]),
    (["read"], ["write"], False),
    (False, True, False),
    (True, False, False),
    ([], True, []),
    (True, [], True),
    ([], ["read"], ["read"]),
    (["read"], [], ["read"]),
    ([], [], []),
    ([], False, False),
])
def test_scope_intersection_preserves_wildcard_and_disable_semantics(
    saved: list[str] | bool, current: list[str] | bool, expected: list[str] | bool,
) -> None:
    result = intersect_allowed_tools({"primary": saved}, {"primary": current})
    assert result == {"primary": expected}
    if isinstance(result["primary"], list):
        assert result["primary"] is not saved and result["primary"] is not current


def test_removed_servers_and_new_grants_are_not_reintroduced() -> None:
    assert intersect_allowed_tools(
        {"removed": True, "primary": ["read"]}, {"primary": ["read", "write"], "new": True},
    ) == {"primary": ["read"]}


def test_disjoint_scopes_really_disable_tools_in_the_native_filter() -> None:
    tools = [SimpleNamespace(name="primary_read"), SimpleNamespace(name="primary_write")]
    scopes = intersect_allowed_tools({"primary": ["read"]}, {"primary": ["write"]})
    selected, missing = filter_tools_by_allowed(tools, scopes)
    assert selected == [] and missing == []
