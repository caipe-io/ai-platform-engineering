"""Tests for lookback_days change detection in sync_slack_channels."""

from __future__ import annotations

import importlib
import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from common.models.rag import DataSourceInfo

SLACK_ENV = {
  "SLACK_BOT_NAME": "test-bot",
  "SLACK_BOT_TOKEN": "xoxb-fake-token",
  "SLACK_WORKSPACE_URL": "https://test.slack.com",
  "SLACK_CHANNELS": '{"C123":{"name":"test-channel","lookback_days":7,"include_bots":false}}',
}


@pytest.fixture(autouse=True)
def _patch_slack_env(monkeypatch):
  for key, val in SLACK_ENV.items():
    monkeypatch.setenv(key, val)


def _make_client(datasources=None):
  client = AsyncMock()
  client.ingestor_id = "slack:test-bot"
  client.list_datasources = AsyncMock(return_value=datasources or [])
  client.upsert_datasource = AsyncMock()
  client.create_job = AsyncMock(return_value={"job_id": "job-1"})
  client.update_job = AsyncMock()
  client.ingest_documents = AsyncMock()
  client.add_job_error = AsyncMock()
  return client


def _make_ds(channel_id, last_ts, lookback_days):
  return DataSourceInfo(
    datasource_id=f"slack-channel-{channel_id}",
    ingestor_id="slack:test-bot",
    source_type="slack",
    last_updated=1000000,
    metadata={"channel_id": channel_id, "channel_name": "test-channel", "last_ts": last_ts, "workspace_url": "https://test.slack.com", "lookback_days": lookback_days},
  )


async def _run_sync(client, mock_syncer, channels_config=None):
  import ingestors.slack.ingestor as mod

  importlib.reload(mod)
  env_patch = (
    {"SLACK_CHANNELS": json.dumps(channels_config)}
    if channels_config is not None
    else {}
  )
  with patch.dict(os.environ, env_patch):
    with patch.object(mod, "SlackChannelSyncer", return_value=mock_syncer):
      with patch.object(mod, "WebClient"):
        await mod.sync_slack_channels(client)


@pytest.mark.asyncio
async def test_lookback_unchanged_uses_incremental_sync():
  """Stored lookback_days == config → uses last_ts for incremental sync."""
  ds = _make_ds("C123", last_ts="1700000000.000000", lookback_days=7)
  client = _make_client(datasources=[ds])
  syncer = MagicMock()
  syncer.fetch_channel_messages = MagicMock(return_value=([], "1700000000.000000"))

  await _run_sync(client, syncer)

  syncer.fetch_channel_messages.assert_called_once_with("C123", "test-channel", 7, "1700000000.000000")


@pytest.mark.asyncio
async def test_lookback_changed_resets_last_ts():
  """Stored lookback_days != config → resets last_ts to None for full re-fetch."""
  ds = _make_ds("C123", last_ts="1700000000.000000", lookback_days=7)
  client = _make_client(datasources=[ds])
  syncer = MagicMock()
  syncer.fetch_channel_messages = MagicMock(return_value=([], "1700000000.000000"))

  await _run_sync(client, syncer, channels_config={"C123": {"name": "test-channel", "lookback_days": 14, "include_bots": False}})

  syncer.fetch_channel_messages.assert_called_once_with("C123", "test-channel", 14, None)
