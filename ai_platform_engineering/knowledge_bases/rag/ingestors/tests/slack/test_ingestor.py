"""Tests for reload_datasource's lookback_days change detection.

PR #1035 (merged 2026-03-24) taught the now-deleted sync_slack_channels to compare a
freshly-configured lookback_days against the previously stored one and reset last_ts to
force a full re-fetch on divergence. PR #2701 (merged 2026-09-08) replaced that env-var
config path with per-datasource metadata managed via PATCH /v1/datasource/{id}, and
reload_datasource inherited none of that detection: it always resumes from the stored
last_ts, so a lookback_days change made through the API has no effect on what gets
fetched until this fix restores the comparison against a persisted synced_lookback_days.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from common.job_manager import JobInfo, JobStatus
from common.models.rag import DataSourceInfo
from common.models.server import SlackIngestRequest

import ingestors.slack.ingestor as ingestor_module
from ingestors.slack.ingestor import process_channel_ingestion, reload_datasource


def make_datasource(
  datasource_id: str = "slack-channel-C123",
  last_ts: str | None = "1700000000.000000",
  lookback_days: int = 7,
  synced_lookback_days: int | None = 7,
) -> DataSourceInfo:
  metadata = {
    "channel_id": "C123",
    "channel_name": "test-channel",
    "workspace_url": "https://test.slack.com",
    "lookback_days": lookback_days,
    "last_ts": last_ts,
  }
  if synced_lookback_days is not None:
    metadata["synced_lookback_days"] = synced_lookback_days
  return DataSourceInfo(
    datasource_id=datasource_id,
    ingestor_id="slack:test-bot",
    source_type="slack",
    last_updated=1000000,
    metadata=metadata,
  )


def make_client() -> MagicMock:
  client = MagicMock()
  client.ingestor_id = "slack:test-bot"
  client.upsert_datasource = AsyncMock()
  client.create_job = AsyncMock(return_value={"job_id": "job-1"})
  client.ingest_documents = AsyncMock()
  client.update_job = AsyncMock()
  return client


def make_job_manager() -> MagicMock:
  jm = MagicMock()
  jm.upsert_job = AsyncMock()
  jm.add_error_msg = AsyncMock()
  return jm


@pytest.fixture(autouse=True)
def _slack_bot_token(monkeypatch):
  monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-fake-token")


async def _run_reload(ds: DataSourceInfo, newest_ts: str = "1700000000.000000"):
  client = make_client()
  jm = make_job_manager()
  syncer = MagicMock()
  # No new messages: reload_datasource returns right after persisting the checkpoint,
  # so the test only needs to observe what fetch_channel_messages was called with and
  # what got written back to datasource_info.metadata.
  syncer.fetch_channel_messages = MagicMock(return_value=([], newest_ts))

  with patch.object(ingestor_module, "SlackChannelSyncer", return_value=syncer):
    with patch.object(ingestor_module, "WebClient"):
      await reload_datasource(client, jm, ds)

  return client, syncer, ds


class TestReloadDatasourceLookbackChange:
  """reload_datasource must detect a lookback_days change and force a full re-fetch."""

  async def test_lookback_unchanged_uses_incremental_sync(self):
    ds = make_datasource(last_ts="1700000000.000000", lookback_days=7, synced_lookback_days=7)

    client, syncer, ds = await _run_reload(ds)

    syncer.fetch_channel_messages.assert_called_once_with(
      "C123", "test-channel", 7, "1700000000.000000", raise_on_error=False,
    )
    assert ds.metadata["synced_lookback_days"] == 7

  async def test_lookback_changed_resets_last_ts_for_full_resync(self):
    ds = make_datasource(last_ts="1700000000.000000", lookback_days=30, synced_lookback_days=7)

    client, syncer, ds = await _run_reload(ds)

    syncer.fetch_channel_messages.assert_called_once_with(
      "C123", "test-channel", 30, None, raise_on_error=False,
    )
    # The new lookback_days is recorded so the *next* reload sees it as unchanged.
    assert ds.metadata["synced_lookback_days"] == 30

  async def test_legacy_metadata_with_no_synced_lookback_does_not_force_resync(self):
    """A datasource persisted before this fix has no synced_lookback_days yet; absence
    must not be misread as 'always changed', or every reload of pre-existing datasources
    would force an unwanted full re-fetch the first time this fix runs."""
    ds = make_datasource(last_ts="1700000000.000000", lookback_days=7, synced_lookback_days=None)
    assert "synced_lookback_days" not in ds.metadata

    client, syncer, ds = await _run_reload(ds)

    syncer.fetch_channel_messages.assert_called_once_with(
      "C123", "test-channel", 7, "1700000000.000000", raise_on_error=False,
    )
    # Backfilled going forward so a later real change can be detected.
    assert ds.metadata["synced_lookback_days"] == 7

  async def test_reload_persists_checkpoint_before_returning(self):
    ds = make_datasource(last_ts="1700000000.000000", lookback_days=30, synced_lookback_days=7)

    client, syncer, ds = await _run_reload(ds, newest_ts="1700000000.000000")

    client.upsert_datasource.assert_awaited_once()
    persisted = client.upsert_datasource.call_args.args[0]
    assert persisted.metadata["synced_lookback_days"] == 30


class TestProcessChannelIngestionSeedsSyncedLookback:
  """The first (on-demand) sync must seed synced_lookback_days too, or the very next
  reload has nothing to compare lookback_days against and can never detect a change."""

  async def test_first_sync_seeds_synced_lookback_days(self):
    ds = make_datasource(last_ts=None, lookback_days=7, synced_lookback_days=None)
    ds.metadata.pop("last_ts", None)
    client = make_client()
    client.list_datasources = AsyncMock(return_value=[ds])
    job_manager = make_job_manager()
    job_manager.get_job = AsyncMock(
      return_value=JobInfo(job_id="job-1", status=JobStatus.PENDING, created_at=0, datasource_id=ds.datasource_id)
    )
    request = SlackIngestRequest(channel_id="C123", lookback_days=7, reload_interval=86400)
    syncer = MagicMock()
    syncer.fetch_channel_messages = MagicMock(return_value=([], "1700000000.000000"))

    with patch.object(ingestor_module, "SlackChannelSyncer", return_value=syncer):
      with patch.object(ingestor_module, "WebClient"):
        await process_channel_ingestion(client, job_manager, request, "job-1")

    client.upsert_datasource.assert_awaited_once()
    persisted = client.upsert_datasource.call_args.args[0]
    assert persisted.metadata["synced_lookback_days"] == 7
