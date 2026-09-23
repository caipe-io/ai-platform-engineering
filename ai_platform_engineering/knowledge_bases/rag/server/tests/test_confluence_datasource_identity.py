"""Confluence datasource identity and display metadata tests."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from common.models.server import ConfluenceIngestRequest
from server import restapi


PAGE_URL = "https://wiki.example.com/wiki/spaces/ENG/pages/123456/Overview"
FOLDER_URL = "https://wiki.example.com/wiki/spaces/ENG/folder/789"
SPACE_URL = "https://wiki.example.com/wiki/spaces/ENG"


def _request(url: str = PAGE_URL, **overrides: object) -> ConfluenceIngestRequest:
  return ConfluenceIngestRequest(url=url, reload_interval=86400, **overrides)


def test_new_confluence_source_identity_includes_root_page() -> None:
  assert restapi.resolve_confluence_datasource_id(
    _request(),
    "ENG",
    "123456",
    "page",
  ) == "src_confluence___wiki_example_com__ENG__123456"


def test_new_confluence_source_identity_sanitizes_legacy_unsafe_space_key() -> None:
  assert restapi.resolve_confluence_datasource_id(
    _request(),
    "Control Plane",
    "123456",
    "page",
  ) == "src_confluence___wiki_example_com__Control_Plane__123456"


def test_new_confluence_folder_source_identity_is_distinct_from_a_page() -> None:
  folder_id = restapi.resolve_confluence_datasource_id(
    _request(url=FOLDER_URL),
    "ENG",
    "789",
    "folder",
  )
  page_id = restapi.resolve_confluence_datasource_id(
    _request(),
    "ENG",
    "789",
    "page",
  )
  assert folder_id == "src_confluence___wiki_example_com__ENG__folder__789"
  assert folder_id != page_id


def test_new_confluence_space_source_identity_omits_content_id() -> None:
  assert restapi.resolve_confluence_datasource_id(
    _request(url=SPACE_URL),
    "ENG",
    None,
    "space",
  ) == "src_confluence___wiki_example_com__ENG"


def test_preprovisioned_legacy_space_identity_remains_supported() -> None:
  legacy_id = "src_confluence___wiki_example_com__ENG"

  assert restapi.resolve_confluence_datasource_id(
    _request(
      ownership_preprovisioned=True,
      preprovisioned_datasource_id=legacy_id,
    ),
    "ENG",
    "123456",
    "page",
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
      "page",
    )


def test_default_description_explains_page_scope() -> None:
  assert restapi.confluence_scope_description(_request(), "page") == (
    f"Confluence page {PAGE_URL}"
  )
  assert restapi.confluence_scope_description(
    _request(get_child_pages=True), "page",
  ) == f"Confluence page and child pages starting at {PAGE_URL}"


def test_default_description_explains_folder_scope() -> None:
  assert restapi.confluence_scope_description(_request(url=FOLDER_URL), "folder") == (
    f"Confluence folder (all nested pages) at {FOLDER_URL}"
  )


def test_default_description_explains_space_scope() -> None:
  assert restapi.confluence_scope_description(_request(url=SPACE_URL), "space") == (
    f"Entire Confluence space at {SPACE_URL}"
  )
