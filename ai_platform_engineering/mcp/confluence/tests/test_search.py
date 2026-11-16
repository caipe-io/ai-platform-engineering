"""CQL reads retain query boundaries and propagate upstream failures."""

import asyncio
from unittest.mock import AsyncMock

import pytest

from tools import search


def test_search_preserves_query_paging_and_optional_body(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {"results": [{"title": "Example page", "url": "/wiki/example"}]}
    request = AsyncMock(return_value=(True, payload))
    monkeypatch.setattr(search, "make_api_request", request)

    result = asyncio.run(search.search_content(' type = page AND title ~ "example" ', limit=2, start=4, include_body=True))

    assert result == payload
    request.assert_awaited_once_with(
        "/search", method="GET",
        params={"cql": 'type = page AND title ~ "example"', "limit": 2, "start": 4, "expand": "content.space,content.body.storage"},
    )


def test_search_omits_page_bodies_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    request = AsyncMock(return_value=(True, {"results": []}))
    monkeypatch.setattr(search, "make_api_request", request)

    assert asyncio.run(search.search_content("type = page")) == {"results": []}
    assert request.await_args.kwargs["params"]["expand"] == "content.space"


@pytest.mark.parametrize("arguments", [{"cql": " "}, {"cql": "a" * 4097}, {"cql": "type = page", "limit": 0}, {"cql": "type = page", "limit": 51}, {"cql": "type = page", "start": -1}])
def test_invalid_search_never_dispatches(monkeypatch: pytest.MonkeyPatch, arguments: dict[str, object]) -> None:
    request = AsyncMock()
    monkeypatch.setattr(search, "make_api_request", request)
    with pytest.raises(ValueError):
        asyncio.run(search.search_content(**arguments))
    request.assert_not_awaited()


def test_search_does_not_hide_provider_denial(monkeypatch: pytest.MonkeyPatch) -> None:
    request = AsyncMock(return_value=(False, {"error": "API request failed: 403"}))
    monkeypatch.setattr(search, "make_api_request", request)

    with pytest.raises(RuntimeError, match="API request failed: 403"):
        asyncio.run(search.search_content("type = page"))
    assert request.await_count == 1
