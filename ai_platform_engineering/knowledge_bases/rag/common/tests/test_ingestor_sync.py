"""
Tests for IngestorBuilder._calculate_next_sync_time and tight-loop safeguard.

Covers the bug where _calculate_next_sync_time used self._sync_interval (CHECK_INTERVAL)
as the reload interval fallback instead of DEFAULT_RELOAD_INTERVAL, causing a tight loop
when datasources were older than CHECK_INTERVAL but younger than DEFAULT_RELOAD_INTERVAL.
"""

import time
from unittest.mock import AsyncMock, patch

import pytest

from common.constants import (
  DATASOURCE_SCHEDULE_CHECK_INTERVAL,
  DEFAULT_RELOAD_INTERVAL,
  MIN_RELOAD_INTERVAL,
)
from common.ingestor import IngestorBuilder
from common.models.rag import DataSourceInfo


def _make_datasource(
  datasource_id: str = "ds_1",
  last_updated: int | None = None,
  reload_interval: int | None = None,
) -> DataSourceInfo:
  return DataSourceInfo(
    datasource_id=datasource_id,
    ingestor_id="webloader:default",
    source_type="web",
    last_updated=last_updated,
    **({"reload_interval": reload_interval} if reload_interval is not None else {}),
  )


def _make_builder(sync_interval: int = 600) -> IngestorBuilder:
  builder = IngestorBuilder()
  builder._sync_interval = sync_interval
  return builder


def _mock_client(datasources: list[DataSourceInfo]) -> AsyncMock:
  client = AsyncMock()
  client.ingestor_id = "webloader:default"
  client.list_datasources = AsyncMock(return_value=datasources)
  return client


class TestCalculateNextSyncTime:
  """Tests for IngestorBuilder._calculate_next_sync_time"""

  @pytest.mark.asyncio
  async def test_no_datasources_never_synced_returns_immediate(self):
    builder = _make_builder()
    client = _mock_client([])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 0
    assert has_ds is False

  @pytest.mark.asyncio
  async def test_no_datasources_recently_synced_returns_remaining_time(self):
    builder = _make_builder(sync_interval=600)
    builder._last_sync_time = int(time.time()) - 100
    client = _mock_client([])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert 400 <= sleep_time <= 500
    assert has_ds is False

  @pytest.mark.asyncio
  async def test_no_datasources_sync_overdue_returns_immediate(self):
    builder = _make_builder(sync_interval=600)
    builder._last_sync_time = int(time.time()) - 1000
    client = _mock_client([])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 0
    assert has_ds is False

  @pytest.mark.asyncio
  async def test_datasource_never_updated_returns_immediate(self):
    ds = _make_datasource(last_updated=None)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 0
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_datasource_no_metadata_uses_default_reload_interval(self):
    """The core bug fix: without reload_interval in metadata, should use
    DEFAULT_RELOAD_INTERVAL (86400s), NOT self._sync_interval (600s)."""
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 3600)  # 1 hour ago
    builder = _make_builder(sync_interval=600)
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # Should sleep ~82800s (86400 - 3600), NOT return 0 (which old code did: 600 - 3600 < 0)
    assert sleep_time > 80000
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_old_bug_scenario_no_tight_loop(self):
    """Reproduces the exact production scenario: 3 datasources updated 8h ago,
    sync_interval=600. Old code returned sleep_time=0 causing tight loop."""
    now = int(time.time())
    eight_hours_ago = now - 29000
    datasources = [_make_datasource(datasource_id=f"ds_{i}", last_updated=eight_hours_ago) for i in range(3)]
    builder = _make_builder(sync_interval=600)
    client = _mock_client(datasources)
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # Must NOT return 0 — that was the bug
    assert sleep_time > 0, "sleep_time=0 would cause tight loop"
    assert sleep_time > 50000  # ~57400s remaining of 86400
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_datasource_with_explicit_reload_interval(self):
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 1800, reload_interval=3600)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # 3600 - 1800 = 1800s remaining
    assert 1700 <= sleep_time <= 1800
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_datasource_overdue_with_explicit_interval_returns_immediate(self):
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 7200, reload_interval=3600)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 0
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_reload_interval_below_minimum_is_clamped(self):
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 30, reload_interval=10)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # Should use MIN_RELOAD_INTERVAL (60s): 60 - 30 = 30s
    assert 25 <= sleep_time <= MIN_RELOAD_INTERVAL
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_multiple_datasources_returns_earliest(self):
    now = int(time.time())
    ds1 = _make_datasource(datasource_id="ds_1", last_updated=now - 100, reload_interval=3600)
    ds2 = _make_datasource(datasource_id="ds_2", last_updated=now - 200, reload_interval=3600)
    builder = _make_builder()
    client = _mock_client([ds1, ds2])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # ds2 is older, so it's due first: 3600 - 200 = 3400
    assert 3300 <= sleep_time <= 3400
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_min_sleep_time_enforced(self):
    """Even if time_until_reload is small but positive, enforce 60s minimum."""
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 3590, reload_interval=3600)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # 3600 - 3590 = 10s, but MIN_SLEEP_TIME = 60
    assert sleep_time >= 60

  @pytest.mark.asyncio
  async def test_client_error_falls_back_to_sync_interval(self):
    builder = _make_builder(sync_interval=600)
    client = _mock_client([])
    client.list_datasources = AsyncMock(side_effect=Exception("connection error"))
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 600
    assert has_ds is False

  @pytest.mark.asyncio
  async def test_datasource_schedule_uses_internal_retry_on_client_error(self):
    builder = IngestorBuilder().schedule_from_datasources()
    builder._last_sync_time = int(time.time())
    client = _mock_client([])
    client.list_datasources = AsyncMock(side_effect=Exception("connection error"))

    sleep_time, has_ds = await builder._calculate_next_sync_time(client)

    assert sleep_time == DATASOURCE_SCHEDULE_CHECK_INTERVAL
    assert has_ds is False

  @pytest.mark.asyncio
  async def test_datasource_schedule_rechecks_before_a_long_interval_is_due(self):
    now = int(time.time())
    datasource = _make_datasource(
      last_updated=now,
      reload_interval=DEFAULT_RELOAD_INTERVAL,
    )
    builder = IngestorBuilder().schedule_from_datasources()
    builder._last_sync_time = now

    sleep_time, has_ds = await builder._calculate_next_sync_time(
      _mock_client([datasource])
    )

    assert sleep_time == DATASOURCE_SCHEDULE_CHECK_INTERVAL
    assert has_ds is True
    assert builder._schedule_check_only is True

  @pytest.mark.asyncio
  async def test_datasource_schedule_runs_once_at_worker_startup(self):
    now = int(time.time())
    datasource = _make_datasource(
      last_updated=now,
      reload_interval=DEFAULT_RELOAD_INTERVAL,
    )
    builder = IngestorBuilder().schedule_from_datasources()

    sleep_time, has_ds = await builder._calculate_next_sync_time(
      _mock_client([datasource])
    )

    assert sleep_time == 0
    assert has_ds is True
    assert builder._schedule_check_only is False

  @pytest.mark.asyncio
  async def test_datasource_schedule_waits_until_due_without_connector_check(self):
    now = int(time.time())
    datasource = _make_datasource(
      last_updated=now - 30,
      reload_interval=MIN_RELOAD_INTERVAL,
    )
    builder = IngestorBuilder().schedule_from_datasources()
    builder._last_sync_time = now - 30

    sleep_time, has_ds = await builder._calculate_next_sync_time(
      _mock_client([datasource])
    )

    assert 25 <= sleep_time <= 30
    assert has_ds is True
    assert builder._schedule_check_only is False

  @pytest.mark.asyncio
  async def test_datasource_schedule_without_sources_retries_internally(self):
    builder = IngestorBuilder().schedule_from_datasources()
    builder._last_sync_time = int(time.time()) - 10_000

    sleep_time, has_ds = await builder._calculate_next_sync_time(_mock_client([]))

    assert sleep_time == DATASOURCE_SCHEDULE_CHECK_INTERVAL
    assert has_ds is False
    assert builder._schedule_check_only is True

  @pytest.mark.asyncio
  async def test_datasource_empty_metadata_dict_uses_default(self):
    """metadata={} (no reload_interval key) should use DEFAULT_RELOAD_INTERVAL."""
    now = int(time.time())
    ds = DataSourceInfo(
      datasource_id="ds_1",
      ingestor_id="webloader:default",
      source_type="web",
      last_updated=now - 3600,
      metadata={},
    )
    builder = _make_builder(sync_interval=600)
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time > 80000  # 86400 - 3600 = 82800
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_reload_interval_zero_is_clamped_to_minimum(self):
    """reload_interval=0 should be clamped to MIN_RELOAD_INTERVAL."""
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 30, reload_interval=0)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # Clamped to MIN_RELOAD_INTERVAL (60): 60 - 30 = 30
    assert 25 <= sleep_time <= MIN_RELOAD_INTERVAL
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_reload_interval_negative_is_clamped_to_minimum(self):
    """Negative reload_interval should be clamped to MIN_RELOAD_INTERVAL."""
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 10, reload_interval=-100)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # Clamped to MIN_RELOAD_INTERVAL (60): 60 - 10 = 50
    assert 45 <= sleep_time <= MIN_RELOAD_INTERVAL
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_datasource_just_updated_returns_full_interval(self):
    """Datasource updated just now should sleep for the full DEFAULT_RELOAD_INTERVAL."""
    now = int(time.time())
    ds = _make_datasource(last_updated=now)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time >= DEFAULT_RELOAD_INTERVAL - 2  # within 2s tolerance
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_mix_explicit_and_default_intervals(self):
    """One datasource with explicit interval, one using default — picks earliest."""
    now = int(time.time())
    ds_explicit = _make_datasource(datasource_id="ds_explicit", last_updated=now - 1800, reload_interval=3600)  # due in 1800s
    ds_default = _make_datasource(datasource_id="ds_default", last_updated=now - 3600)  # due in 82800s (DEFAULT 86400 - 3600)
    builder = _make_builder()
    client = _mock_client([ds_explicit, ds_default])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # ds_explicit is due first (1800s)
    assert 1700 <= sleep_time <= 1800

  @pytest.mark.asyncio
  async def test_mix_one_overdue_one_fresh_returns_immediate(self):
    """If any datasource is overdue, return immediate regardless of others."""
    now = int(time.time())
    ds_fresh = _make_datasource(datasource_id="ds_fresh", last_updated=now - 100, reload_interval=3600)
    ds_overdue = _make_datasource(datasource_id="ds_overdue", last_updated=now - 7200, reload_interval=3600)
    builder = _make_builder()
    # Put fresh first — overdue should still trigger immediate
    client = _mock_client([ds_fresh, ds_overdue])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 0
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_mix_one_never_updated_returns_immediate(self):
    """If any datasource was never updated, return immediate."""
    now = int(time.time())
    ds_fresh = _make_datasource(datasource_id="ds_fresh", last_updated=now - 100, reload_interval=3600)
    ds_never = _make_datasource(datasource_id="ds_never", last_updated=None)
    builder = _make_builder()
    # Put fresh first — never-updated should still trigger immediate
    client = _mock_client([ds_fresh, ds_never])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 0
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_time_until_reload_exactly_zero_returns_immediate(self):
    """Boundary: time_until_reload == 0 should trigger immediate sync."""
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 3600, reload_interval=3600)
    builder = _make_builder()
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 0
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_no_datasources_sync_exactly_at_boundary(self):
    """Boundary: time_until_next_sync == 0 should return immediate."""
    builder = _make_builder(sync_interval=600)
    builder._last_sync_time = int(time.time()) - 600  # exactly at boundary
    client = _mock_client([])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    assert sleep_time == 0
    assert has_ds is False

  @pytest.mark.asyncio
  async def test_single_datasource_large_sync_interval_small_reload(self):
    """sync_interval much larger than reload_interval — should use per-ds interval."""
    now = int(time.time())
    ds = _make_datasource(last_updated=now - 50, reload_interval=120)
    builder = _make_builder(sync_interval=86400)
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # 120 - 50 = 70, but MIN_SLEEP_TIME = 60, so max(60, 70) = 70
    assert 65 <= sleep_time <= 70

  @pytest.mark.asyncio
  async def test_datasource_metadata_none_uses_default(self):
    """metadata=None explicitly should use DEFAULT_RELOAD_INTERVAL."""
    now = int(time.time())
    ds = DataSourceInfo(
      datasource_id="ds_1",
      ingestor_id="webloader:default",
      source_type="web",
      last_updated=now - 1000,
      metadata=None,
    )
    builder = _make_builder(sync_interval=600)
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # 86400 - 1000 = 85400
    assert sleep_time > 85000
    assert has_ds is True

  @pytest.mark.asyncio
  async def test_metadata_with_other_keys_no_reload_interval(self):
    """metadata has keys but no reload_interval — should use default."""
    now = int(time.time())
    ds = DataSourceInfo(
      datasource_id="ds_1",
      ingestor_id="webloader:default",
      source_type="web",
      last_updated=now - 2000,
      metadata={"url_ingest_request": {"url": "https://example.com"}},
    )
    builder = _make_builder(sync_interval=600)
    client = _mock_client([ds])
    sleep_time, has_ds = await builder._calculate_next_sync_time(client)
    # 86400 - 2000 = 84400
    assert sleep_time > 84000
    assert has_ds is True


class TestTightLoopSafeguard:
  """Tests for the tight-loop safeguard in the main loop."""

  @pytest.mark.asyncio
  async def test_metadata_recheck_does_not_run_connector_sync(self):
    builder = IngestorBuilder().schedule_from_datasources()
    builder._name = "test"
    builder._type = "test"
    builder._description = "test"
    builder._metadata = {}
    builder._sync_function = AsyncMock()
    builder._last_sync_time = int(time.time())

    mock_client = _mock_client([])
    mock_client.initialize = AsyncMock()
    mock_client.shutdown = AsyncMock()
    calculate_calls = 0

    async def calculate_next_sync(_client):
      nonlocal calculate_calls
      calculate_calls += 1
      if calculate_calls == 1:
        builder._schedule_check_only = True
        return (DATASOURCE_SCHEDULE_CHECK_INTERVAL, False)
      raise RuntimeError("stop after metadata recheck")

    with patch("common.ingestor.Client", return_value=mock_client):
      with patch.object(
        builder,
        "_calculate_next_sync_time",
        side_effect=calculate_next_sync,
      ):
        with patch("asyncio.sleep", new_callable=AsyncMock):
          with pytest.raises(RuntimeError, match="stop after metadata recheck"):
            await builder._run_ingestor()

    builder._sync_function.assert_not_awaited()

  @pytest.mark.asyncio
  async def test_safeguard_backs_off_when_sync_too_recent(self):
    """If sleep_time=0 and last sync was recent, should back off."""
    builder = _make_builder(sync_interval=600)
    builder._name = "test"
    builder._type = "test"
    builder._description = "test"
    builder._metadata = {}
    builder._sync_function = AsyncMock()
    builder._last_sync_time = int(time.time()) - 30  # synced 30s ago

    mock_client = _mock_client([])
    mock_client.initialize = AsyncMock()
    mock_client.shutdown = AsyncMock()

    sleep_called_with = []

    async def capture_sleep(seconds):
      sleep_called_with.append(seconds)
      raise StopIteration()

    with patch("common.ingestor.Client", return_value=mock_client):
      with patch.object(builder, "_calculate_next_sync_time", new_callable=AsyncMock) as mock_calc:
        mock_calc.return_value = (0, True)
        with patch("asyncio.sleep", side_effect=capture_sleep):
          try:
            await builder._run_ingestor()
          except (StopIteration, RuntimeError):
            pass

    assert len(sleep_called_with) > 0
    # Should back off: MIN_LOOP_SLEEP(600) - 30 = 570
    assert sleep_called_with[0] >= 500

  @pytest.mark.asyncio
  async def test_no_backoff_on_first_sync(self):
    """First sync after startup should run immediately (no _last_sync_time)."""
    builder = _make_builder(sync_interval=600)
    builder._name = "test"
    builder._type = "test"
    builder._description = "test"
    builder._metadata = {}
    builder._last_sync_time = None  # never synced

    sync_count = 0

    async def fake_sync(client):
      nonlocal sync_count
      sync_count += 1
      raise StopIteration()

    builder._sync_function = fake_sync

    mock_client = _mock_client([])
    mock_client.initialize = AsyncMock()
    mock_client.shutdown = AsyncMock()

    sleep_called = False

    async def detect_sleep(seconds):
      nonlocal sleep_called
      sleep_called = True

    with patch("common.ingestor.Client", return_value=mock_client):
      with patch.object(builder, "_calculate_next_sync_time", new_callable=AsyncMock) as mock_calc:
        mock_calc.return_value = (0, True)
        with patch("asyncio.sleep", side_effect=detect_sleep):
          try:
            await builder._run_ingestor()
          except (StopIteration, RuntimeError):
            pass

    # Should NOT have slept before first sync
    assert not sleep_called
    assert sync_count == 1

  @pytest.mark.asyncio
  async def test_no_backoff_when_last_sync_at_boundary(self):
    """Last sync was exactly MIN_LOOP_SLEEP ago — should NOT back off."""
    builder = _make_builder(sync_interval=600)
    builder._name = "test"
    builder._type = "test"
    builder._description = "test"
    builder._metadata = {}
    builder._last_sync_time = int(time.time()) - 600  # exactly at boundary

    sync_count = 0

    async def fake_sync(client):
      nonlocal sync_count
      sync_count += 1
      raise StopIteration()

    builder._sync_function = fake_sync

    mock_client = _mock_client([])
    mock_client.initialize = AsyncMock()
    mock_client.shutdown = AsyncMock()

    sleep_called_with = []

    async def capture_sleep(seconds):
      sleep_called_with.append(seconds)

    with patch("common.ingestor.Client", return_value=mock_client):
      with patch.object(builder, "_calculate_next_sync_time", new_callable=AsyncMock) as mock_calc:
        mock_calc.return_value = (0, True)
        with patch("asyncio.sleep", side_effect=capture_sleep):
          try:
            await builder._run_ingestor()
          except (StopIteration, RuntimeError):
            pass

    # Should NOT have slept — at boundary means not "less than"
    assert len(sleep_called_with) == 0
    assert sync_count == 1

  @pytest.mark.asyncio
  async def test_no_backoff_when_last_sync_past_boundary(self):
    """Last sync was more than MIN_LOOP_SLEEP ago — should NOT back off."""
    builder = _make_builder(sync_interval=600)
    builder._name = "test"
    builder._type = "test"
    builder._description = "test"
    builder._metadata = {}
    builder._last_sync_time = int(time.time()) - 700  # past boundary

    sync_count = 0

    async def fake_sync(client):
      nonlocal sync_count
      sync_count += 1
      raise StopIteration()

    builder._sync_function = fake_sync

    mock_client = _mock_client([])
    mock_client.initialize = AsyncMock()
    mock_client.shutdown = AsyncMock()

    sleep_called_with = []

    async def capture_sleep(seconds):
      sleep_called_with.append(seconds)

    with patch("common.ingestor.Client", return_value=mock_client):
      with patch.object(builder, "_calculate_next_sync_time", new_callable=AsyncMock) as mock_calc:
        mock_calc.return_value = (0, True)
        with patch("asyncio.sleep", side_effect=capture_sleep):
          try:
            await builder._run_ingestor()
          except (StopIteration, RuntimeError):
            pass

    assert len(sleep_called_with) == 0
    assert sync_count == 1

  @pytest.mark.asyncio
  async def test_positive_sleep_time_sleeps_normally(self):
    """When sleep_time > 0, should sleep for that duration (no backoff logic)."""
    builder = _make_builder(sync_interval=600)
    builder._name = "test"
    builder._type = "test"
    builder._description = "test"
    builder._metadata = {}
    builder._sync_function = AsyncMock()
    builder._last_sync_time = int(time.time()) - 10  # very recent

    mock_client = _mock_client([])
    mock_client.initialize = AsyncMock()
    mock_client.shutdown = AsyncMock()

    sleep_called_with = []

    async def capture_sleep(seconds):
      sleep_called_with.append(seconds)
      raise StopIteration()

    with patch("common.ingestor.Client", return_value=mock_client):
      with patch.object(builder, "_calculate_next_sync_time", new_callable=AsyncMock) as mock_calc:
        mock_calc.return_value = (5000, True)  # positive sleep
        with patch("asyncio.sleep", side_effect=capture_sleep):
          try:
            await builder._run_ingestor()
          except (StopIteration, RuntimeError):
            pass

    assert len(sleep_called_with) == 1
    assert sleep_called_with[0] == 5000  # sleeps for exactly the returned value
