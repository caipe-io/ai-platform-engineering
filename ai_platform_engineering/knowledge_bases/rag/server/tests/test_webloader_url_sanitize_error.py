"""Non-public URLs must be rejected with a 400, not surface as a 500.

sanitize_url() raises ValueError for hosts that are not publicly routable when
allow_non_public_urls is False; the webloader routes must translate that into
an HTTPException instead of letting it propagate as an unhandled error.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from common.models.rbac import Role, UserContext
from common.models.server import UrlIngestRequest
from server import restapi


def _user() -> UserContext:
  return UserContext(
    subject="test-user",
    email="test-user@example.com",
    role=Role.READONLY,
    is_authenticated=True,
  )


def _request() -> MagicMock:
  return MagicMock(headers={})


def _non_public_url_request() -> UrlIngestRequest:
  return UrlIngestRequest(url="http://127.0.0.1/internal", reload_interval=3600)


@pytest.mark.asyncio
async def test_preview_url_ingestion_rejects_non_public_url_with_400() -> None:
  with pytest.raises(HTTPException) as exc_info:
    await restapi.preview_url_ingestion(
      url_request=_non_public_url_request(),
      request=_request(),
      user=_user(),
    )
  assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_ingest_url_rejects_non_public_url_with_400(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setattr(restapi, "metadata_storage", MagicMock(), raising=False)
  monkeypatch.setattr(restapi, "jobmanager", MagicMock(), raising=False)

  with pytest.raises(HTTPException) as exc_info:
    await restapi.ingest_url(
      url_request=_non_public_url_request(),
      request=_request(),
      user=_user(),
    )
  assert exc_info.value.status_code == 400
