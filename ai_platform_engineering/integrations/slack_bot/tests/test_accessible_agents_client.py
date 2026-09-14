# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for ``slack_bot/utils/accessible_agents_client.py``.

Covers multi-page fetching against the BFF ``/api/user/accessible-agents``
route: accumulating agents across pages, stopping at ``total``, stopping
on an empty page, and the safety cap on pages fetched.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any
from unittest.mock import MagicMock, patch

from ai_platform_engineering.integrations.slack_bot.utils.accessible_agents_client import (
    AccessibleAgentsClient,
)


class _FakeResponse:
    """Drop-in for urllib.urlopen context manager."""

    def __init__(self, status: int, payload: dict[str, Any] | bytes | None):
        self.status = status
        self.code = status
        if isinstance(payload, bytes):
            self._raw = payload
        elif payload is None:
            self._raw = b""
        else:
            self._raw = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self) -> bytes:
        return self._raw


def _page_payload(agents: list[dict[str, str]], total: int) -> dict[str, Any]:
    return {"success": True, "data": {"agents": agents, "total": total}}


def _agent(agent_id: str) -> dict[str, str]:
    return {"id": agent_id, "name": agent_id, "description": ""}


def _requested_pages(mock_open: MagicMock) -> list[int]:
    pages = []
    for call in mock_open.call_args_list:
        request = call.args[0]
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
        pages.append(int(query["page"][0]))
    return pages


class TestAccessibleAgentsClientPagination:
    def test_fetches_all_pages_until_total_reached(self) -> None:
        client = AccessibleAgentsClient(base_url="http://bff.local")
        page_1 = [_agent(f"agent-{i}") for i in range(100)]
        page_2 = [_agent(f"agent-{i}") for i in range(100, 170)]
        responses = [
            _FakeResponse(200, _page_payload(page_1, total=170)),
            _FakeResponse(200, _page_payload(page_2, total=170)),
        ]

        with patch.object(
            AccessibleAgentsClient, "_open", MagicMock(side_effect=responses)
        ) as mock_open:
            result = client.list_agents(bearer_token="tok")

        assert result.available is True
        assert len(result.agents) == 170
        assert result.agents[0].id == "agent-0"
        assert result.agents[-1].id == "agent-169"
        assert mock_open.call_count == 2
        assert _requested_pages(mock_open) == [1, 2]

    def test_single_page_when_total_fits(self) -> None:
        client = AccessibleAgentsClient(base_url="http://bff.local")
        agents = [_agent("github"), _agent("jira")]

        with patch.object(
            AccessibleAgentsClient,
            "_open",
            MagicMock(return_value=_FakeResponse(200, _page_payload(agents, total=2))),
        ) as mock_open:
            result = client.list_agents(bearer_token="tok")

        assert result.available is True
        assert len(result.agents) == 2
        assert mock_open.call_count == 1

    def test_stops_on_empty_page_even_if_total_not_reached(self) -> None:
        client = AccessibleAgentsClient(base_url="http://bff.local")
        page_1 = [_agent("github")]
        responses = [
            _FakeResponse(200, _page_payload(page_1, total=170)),
            _FakeResponse(200, _page_payload([], total=170)),
        ]

        with patch.object(
            AccessibleAgentsClient, "_open", MagicMock(side_effect=responses)
        ) as mock_open:
            result = client.list_agents(bearer_token="tok")

        assert result.available is True
        assert len(result.agents) == 1
        assert mock_open.call_count == 2

    def test_safety_cap_stops_after_max_pages(self) -> None:
        client = AccessibleAgentsClient(base_url="http://bff.local")

        def _never_ending_page(*_args: Any, **_kwargs: Any) -> _FakeResponse:
            return _FakeResponse(200, _page_payload([_agent("x")], total=10_000))

        with patch.object(
            AccessibleAgentsClient, "_open", MagicMock(side_effect=_never_ending_page)
        ) as mock_open:
            result = client.list_agents(bearer_token="tok")

        assert result.available is True
        assert mock_open.call_count == 10
        assert len(result.agents) == 10

    def test_failure_on_a_later_page_returns_unavailable(self) -> None:
        client = AccessibleAgentsClient(base_url="http://bff.local")
        page_1 = [_agent(f"agent-{i}") for i in range(100)]
        responses = [
            _FakeResponse(200, _page_payload(page_1, total=170)),
            _FakeResponse(502, None),
        ]

        with patch.object(
            AccessibleAgentsClient, "_open", MagicMock(side_effect=responses)
        ) as mock_open:
            result = client.list_agents(bearer_token="tok")

        assert result.available is False
        assert result.agents == []
        assert mock_open.call_count == 2

    def test_no_base_url_returns_unavailable_without_request(self) -> None:
        client = AccessibleAgentsClient(base_url="")
        with patch.object(AccessibleAgentsClient, "_open", MagicMock()) as mock_open:
            result = client.list_agents(bearer_token="tok")

        assert result.available is False
        assert result.agents == []
        mock_open.assert_not_called()

    def test_missing_total_falls_back_to_page_length(self) -> None:
        client = AccessibleAgentsClient(base_url="http://bff.local")
        payload = {"success": True, "data": {"agents": [_agent("github")]}}

        with patch.object(
            AccessibleAgentsClient,
            "_open",
            MagicMock(return_value=_FakeResponse(200, payload)),
        ) as mock_open:
            result = client.list_agents(bearer_token="tok")

        assert result.available is True
        assert len(result.agents) == 1
        assert mock_open.call_count == 1
