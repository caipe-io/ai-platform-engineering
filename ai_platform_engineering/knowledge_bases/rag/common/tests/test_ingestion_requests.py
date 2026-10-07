"""Validation for datasource-managed ingestion settings."""

import pytest
from pydantic import ValidationError

from common.models.server import SlackIngestRequest, UrlIngestRequest


def test_web_ingestion_requires_reload_interval() -> None:
  with pytest.raises(ValidationError, match="reload_interval"):
    UrlIngestRequest(url="https://example.com")


def test_shared_ingestion_tuning_requires_reload_interval() -> None:
  with pytest.raises(ValidationError, match="reload_interval"):
    SlackIngestRequest(channel_id="C0123456789")


def test_reload_interval_accepts_supported_value() -> None:
  request = UrlIngestRequest(
    url="https://example.com",
    reload_interval=3600,
  )

  assert request.reload_interval == 3600
