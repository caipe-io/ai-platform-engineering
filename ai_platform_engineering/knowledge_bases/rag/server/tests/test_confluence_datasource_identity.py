"""Confluence datasource identity and display metadata tests."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from common.models.server import ConfluenceIngestRequest
from server import restapi


PAGE_URL = "https://wiki.example.com/wiki/spaces/ENG/pages/123456/Overview"


def _request(**overrides: object) -> ConfluenceIngestRequest:
  return ConfluenceIngestRequest(url=PAGE_URL, reload_interval=86400, **overrides)


def test_new_confluence_source_identity_includes_root_page() -> None:
  assert restapi.resolve_confluence_datasource_id(
    _request(),
    "ENG",
    "123456",
  ) == "src_confluence___wiki_example_com__ENG__123456"


def test_new_confluence_source_identity_sanitizes_legacy_unsafe_space_key() -> None:
  assert restapi.resolve_confluence_datasource_id(
    _request(),
    "Control Plane",
    "123456",
  ) == "src_confluence___wiki_example_com__Control_Plane__123456"


def test_preprovisioned_legacy_space_identity_remains_supported() -> None:
  legacy_id = "src_confluence___wiki_example_com__ENG"

  assert restapi.resolve_confluence_datasource_id(
    _request(
      ownership_preprovisioned=True,
      preprovisioned_datasource_id=legacy_id,
    ),
    "ENG",
    "123456",
  ) == legacy_id


def test_preprovisioned_identity_must_match_page_or_legacy_space() -> None:
  with pytest.raises(HTTPException, match="does not match"):
    restapi.resolve_confluence_datasource_id(
      _request(
        ownership_preprovisioned=True,
        preprovisioned_datasource_id="src_confluence___wiki_example_com__OTHER",
      ),
      "ENG",
      "123456",
    )


def test_default_description_explains_page_scope() -> None:
  assert restapi.confluence_scope_description(_request()) == (
    f"Confluence page {PAGE_URL}"
  )
  assert restapi.confluence_scope_description(
    _request(get_child_pages=True),
  ) == f"Confluence page and child pages starting at {PAGE_URL}"
