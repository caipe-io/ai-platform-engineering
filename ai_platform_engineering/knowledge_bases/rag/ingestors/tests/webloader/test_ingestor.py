"""
Comprehensive unit tests for the Webloader Ingestor module.

Covers:
  - _get_effective_settings: deprecated field mapping, priority rules, all combinations
  - process_url_ingestion: normal flow, terminated job, missing datasource,
    missing job, deprecated fields, ScrapyLoader errors, job error recording
  - reload_datasource: normal flow, missing metadata, missing url_ingest_request,
    deprecated fields in metadata, ScrapyLoader errors, job error recording
  - periodic_reload: normal flow, skip-when-fresh, MIN_RELOAD_INTERVAL clamping,
    never-updated datasource, missing metadata, per-datasource interval,
    error isolation between datasources, empty datasource list

NOTE: The ingestor module imports `loader.*` as a peer-directory package
(it's meant to run from the ingestors/webloader/ directory). We pre-stub
those packages in sys.modules so the module can be imported in a pure
unit-test environment without Scrapy or Twisted.
"""

import sys
import time as time_module
import types
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ---------------------------------------------------------------------------
# Stub out modules the ingestor imports at module-level that require
# environment setup (Scrapy worker pool, Redis client construction, etc.)
# ---------------------------------------------------------------------------


def _make_stub_module(name: str, **attrs) -> types.ModuleType:
  mod = types.ModuleType(name)
  for k, v in attrs.items():
    setattr(mod, k, v)
  return mod


# loader stubs
_loader_pkg = _make_stub_module("loader")
_loader_scrapy = _make_stub_module("loader.scrapy_loader", ScrapyLoader=MagicMock())
_loader_pool = _make_stub_module(
  "loader.worker_pool",
  get_worker_pool=AsyncMock(),
  shutdown_worker_pool=AsyncMock(),
)
_crawl_request_factory = MagicMock()
_loader_types = _make_stub_module(
  "loader.worker_types",
  CrawlDocuments=MagicMock,
  CrawlRequest=_crawl_request_factory,
  CrawlStatus=types.SimpleNamespace(FAILED="failed"),
)
sys.modules.setdefault("loader", _loader_pkg)
sys.modules.setdefault("loader.scrapy_loader", _loader_scrapy)
sys.modules.setdefault("loader.worker_pool", _loader_pool)
sys.modules.setdefault("loader.worker_types", _loader_types)

# redis stub (module-level `Redis.from_url(...)` call)
_redis_instance = MagicMock()
_redis_instance.blpop = AsyncMock(return_value=None)
_redis_instance.smembers = AsyncMock(return_value=set())
_redis_instance.close = AsyncMock()
_redis_mod = _make_stub_module("redis")
_redis_async_mod = _make_stub_module("redis.asyncio")
_redis_class = MagicMock(return_value=_redis_instance)
_redis_class.from_url = MagicMock(return_value=_redis_instance)
_redis_async_mod.Redis = _redis_class
_redis_mod.asyncio = _redis_async_mod
sys.modules.setdefault("redis", _redis_mod)
sys.modules.setdefault("redis.asyncio", _redis_async_mod)

# ---------------------------------------------------------------------------
# Now safely import the module under test
# ---------------------------------------------------------------------------
import ingestors.webloader.ingestor as ingestor_module  # noqa: E402
from ingestors.webloader.ingestor import (  # noqa: E402
  _get_effective_settings,
  preview_url_ingestion,
  process_url_ingestion,
  reload_datasource,
  periodic_reload,
)
from common.constants import DEFAULT_RELOAD_INTERVAL, MIN_RELOAD_INTERVAL  # noqa: E402

# ---------------------------------------------------------------------------
# Domain model imports (from common — these are installed packages)
# ---------------------------------------------------------------------------
from common.models.server import (
  CrawlMode,
  ScrapySettings,
  UrlIngestRequest,
)
from common.models.rag import DataSourceInfo
from common.job_manager import JobInfo, JobStatus

# Alias so helpers can call time.time() for setup
_time = time_module.time


@pytest.mark.asyncio
async def test_preview_uses_bounded_real_crawl_without_persisting():
  request = UrlIngestRequest(
    url="https://example.com/docs",
    settings=ScrapySettings(max_pages=500),
    reload_interval=86400,
  )
  client = MagicMock(ingestor_id="web:primary")
  pool = MagicMock()

  async def crawl(*, request, on_progress, on_documents, timeout):
    assert request is not None
    assert on_progress is None
    assert timeout <= 110
    await on_documents(
      types.SimpleNamespace(
        documents=[
          {
            "id": "doc-1",
            "metadata": {
              "title": "Example docs",
              "metadata": {"source": "https://example.com/docs"},
            },
          }
        ],
      )
    )
    return types.SimpleNamespace(
      status="completed",
      fatal_error=None,
      pages_crawled=1,
      urls_found_in_sitemap=25,
      urls_matched_in_sitemap=8,
      urls_filtered_max_pages=5,
      errors=[],
      pages_failed=0,
      sitemap_url_used=None,
    )

  pool.crawl = AsyncMock(side_effect=crawl)
  with (
    patch.object(ingestor_module, "PREVIEW_MAX_ITEMS", 20),
    patch.object(ingestor_module, "get_worker_pool", AsyncMock(return_value=pool)),
  ):
    result = await preview_url_ingestion(client, request)

  assert result["items"] == [
    {
      "id": "doc-1",
      "title": "Example docs",
      "url": "https://example.com/docs",
    }
  ]
  assert result["total_discovered"] == 8
  assert result["total_is_exact"] is True
  assert result["truncated"] is True
  crawl_request = _crawl_request_factory.call_args.kwargs
  assert crawl_request["max_pages"] == 20


# ---------------------------------------------------------------------------
# Test helpers / factories
# ---------------------------------------------------------------------------


def make_scrapy_settings(**kwargs) -> ScrapySettings:
  return ScrapySettings(**kwargs)


def make_url_request(
  url: str = "https://example.com",
  check_for_sitemaps=None,
  sitemap_max_urls=None,
  ingest_type=None,
  settings: ScrapySettings | None = None,
) -> UrlIngestRequest:
  kwargs: dict = dict(
    url=url,
    reload_interval=86400,
    check_for_sitemaps=check_for_sitemaps,
    sitemap_max_urls=sitemap_max_urls,
    ingest_type=ingest_type,
  )
  # Only pass settings when explicitly provided; otherwise let Pydantic use default_factory
  if settings is not None:
    kwargs["settings"] = settings
  return UrlIngestRequest(**kwargs)


def make_datasource(
  datasource_id: str = "ds-1",
  ingestor_id: str = "ing-1",
  last_updated: int | None = None,
  metadata: dict | None = None,
  source_type: str = "url",
  reload_interval: int | None = None,
) -> DataSourceInfo:
  return DataSourceInfo(
    datasource_id=datasource_id,
    ingestor_id=ingestor_id,
    source_type=source_type,
    last_updated=last_updated,
    metadata=metadata,
    **({"reload_interval": reload_interval} if reload_interval is not None else {}),
  )


def make_job(
  job_id: str = "job-1",
  status: JobStatus = JobStatus.IN_PROGRESS,
  datasource_id: str = "ds-1",
) -> JobInfo:
  return JobInfo(
    job_id=job_id,
    status=status,
    created_at=int(_time()),
    datasource_id=datasource_id,
  )


def make_client(
  ingestor_id: str = "ing-1",
  datasources: list | None = None,
) -> MagicMock:
  client = MagicMock()
  client.ingestor_id = ingestor_id
  client.list_datasources = AsyncMock(return_value=datasources or [])
  client.upsert_datasource = AsyncMock()
  client.create_job = AsyncMock(return_value={"job_id": "reload-job-1"})
  return client


def make_job_manager(jobs: list | None = None) -> MagicMock:
  jm = MagicMock()
  job_list = jobs or []
  jobs_by_id = {job.job_id: job for job in job_list}
  jm.get_job = AsyncMock(side_effect=lambda job_id: jobs_by_id.get(job_id))
  jm.get_jobs_by_datasource = AsyncMock(return_value=job_list)
  jm.upsert_job = AsyncMock()
  jm.add_error_msg = AsyncMock()
  return jm


# ---------------------------------------------------------------------------
# _get_effective_settings
# ---------------------------------------------------------------------------


class TestGetEffectiveSettings:
  """Tests for _get_effective_settings — deprecated field migration logic."""

  def test_no_deprecated_fields_returns_provided_settings(self):
    settings = make_scrapy_settings(crawl_mode=CrawlMode.RECURSIVE, max_pages=50)
    request = make_url_request(settings=settings)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.crawl_mode == CrawlMode.RECURSIVE
    assert eff.max_pages == 50
    assert deprecated == []

  def test_no_settings_uses_defaults(self):
    request = make_url_request()
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.crawl_mode == CrawlMode.SINGLE_URL
    assert eff.max_pages == 2000
    assert deprecated == []

  # check_for_sitemaps -> crawl_mode ------------------------------------------

  def test_check_for_sitemaps_true_maps_to_sitemap_mode(self):
    request = make_url_request(check_for_sitemaps=True)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.crawl_mode == CrawlMode.SITEMAP
    assert "check_for_sitemaps" in deprecated

  def test_check_for_sitemaps_false_keeps_single_url_mode(self):
    request = make_url_request(check_for_sitemaps=False)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.crawl_mode == CrawlMode.SINGLE_URL
    assert "check_for_sitemaps" in deprecated

  def test_check_for_sitemaps_does_not_override_explicit_crawl_mode(self):
    """If crawl_mode was already set explicitly (non-single), deprecated field is ignored."""
    settings = make_scrapy_settings(crawl_mode=CrawlMode.RECURSIVE)
    request = make_url_request(check_for_sitemaps=True, settings=settings)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    # RECURSIVE was explicit; SITEMAP from deprecated field must NOT override it
    assert eff.crawl_mode == CrawlMode.RECURSIVE
    assert "check_for_sitemaps" in deprecated

  def test_check_for_sitemaps_true_does_not_override_sitemap_mode(self):
    """If crawl_mode was already SITEMAP explicitly, deprecated True is a no-op (but still reported)."""
    settings = make_scrapy_settings(crawl_mode=CrawlMode.SITEMAP)
    request = make_url_request(check_for_sitemaps=True, settings=settings)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.crawl_mode == CrawlMode.SITEMAP
    assert "check_for_sitemaps" in deprecated

  def test_check_for_sitemaps_false_with_explicit_single_url_is_no_op(self):
    """False deprecated field with default single → no change."""
    request = make_url_request(check_for_sitemaps=False)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.crawl_mode == CrawlMode.SINGLE_URL

  # sitemap_max_urls -> max_pages -----------------------------------------------

  def test_sitemap_max_urls_maps_to_max_pages(self):
    request = make_url_request(sitemap_max_urls=100)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.max_pages == 100
    assert "sitemap_max_urls" in deprecated

  def test_sitemap_max_urls_does_not_override_explicit_max_pages(self):
    """If max_pages differs from the default 2000, the deprecated field is ignored."""
    settings = make_scrapy_settings(max_pages=500)
    request = make_url_request(sitemap_max_urls=50, settings=settings)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.max_pages == 500
    assert "sitemap_max_urls" in deprecated

  def test_sitemap_max_urls_applies_when_max_pages_is_still_default(self):
    """When max_pages is still the default (2000), the deprecated value wins."""
    settings = make_scrapy_settings(max_pages=2000)
    request = make_url_request(sitemap_max_urls=300, settings=settings)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.max_pages == 300

  def test_sitemap_max_urls_zero_is_applied(self):
    """Zero is a valid (if unusual) override when max_pages is at default."""
    request = make_url_request(sitemap_max_urls=0)
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert eff.max_pages == 0
    assert "sitemap_max_urls" in deprecated

  # ingest_type ----------------------------------------------------------------

  def test_ingest_type_is_logged_as_deprecated_but_has_no_mapping(self):
    request = make_url_request(ingest_type="legacy_type")
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert "ingest_type" in deprecated
    # Settings are otherwise untouched
    assert eff.crawl_mode == CrawlMode.SINGLE_URL
    assert eff.max_pages == 2000

  def test_ingest_type_empty_string_still_deprecated(self):
    request = make_url_request(ingest_type="")
    _, deprecated = _get_effective_settings(request, "ds-1")
    assert "ingest_type" in deprecated

  # Combined deprecated fields -------------------------------------------------

  def test_all_three_deprecated_fields_together(self):
    request = make_url_request(
      check_for_sitemaps=True,
      sitemap_max_urls=42,
      ingest_type="legacy",
    )
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert set(deprecated) == {"check_for_sitemaps", "sitemap_max_urls", "ingest_type"}
    assert eff.crawl_mode == CrawlMode.SITEMAP
    assert eff.max_pages == 42

  def test_deprecated_fields_none_are_ignored(self):
    """All deprecated fields explicitly None → no side effects, empty list."""
    request = make_url_request(
      check_for_sitemaps=None,
      sitemap_max_urls=None,
      ingest_type=None,
    )
    eff, deprecated = _get_effective_settings(request, "ds-1")
    assert deprecated == []
    assert eff.crawl_mode == CrawlMode.SINGLE_URL

  def test_deprecated_fields_list_order(self):
    """Deprecated fields are reported in the order they are detected."""
    request = make_url_request(
      check_for_sitemaps=True,
      sitemap_max_urls=10,
      ingest_type="old",
    )
    _, deprecated = _get_effective_settings(request, "ds-1")
    assert deprecated.index("check_for_sitemaps") < deprecated.index("sitemap_max_urls")
    assert deprecated.index("sitemap_max_urls") < deprecated.index("ingest_type")

  def test_datasource_id_appears_in_deprecation_warning_log(self):
    request = make_url_request(check_for_sitemaps=True)
    with patch.object(ingestor_module.logger, "warning") as mock_warn:
      _get_effective_settings(request, "my-special-datasource-id")
    all_warnings = " ".join(str(c) for c in mock_warn.call_args_list)
    assert "my-special-datasource-id" in all_warnings

  def test_no_settings_provided_creates_default_scrapy_settings(self):
    """When request.settings is None, default ScrapySettings are created."""
    request = UrlIngestRequest(url="https://ex.com", reload_interval=86400)
    assert request.settings is not None  # pydantic default_factory
    eff, _ = _get_effective_settings(request, "ds-1")
    assert isinstance(eff, ScrapySettings)


# ---------------------------------------------------------------------------
# process_url_ingestion
# ---------------------------------------------------------------------------


class TestProcessUrlIngestion:
  """Tests for the main URL ingestion orchestrator."""

  async def test_happy_path_runs_scrapy_loader(self):
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.IN_PROGRESS, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await process_url_ingestion(client, jm, req, "job-xyz")

    jm.upsert_job.assert_any_call(
      job_id="job-xyz",
      status=JobStatus.IN_PROGRESS,
      message="Starting URL ingestion for https://example.com",
    )
    mock_instance.load.assert_awaited_once()
    load_kwargs = mock_instance.load.call_args.kwargs
    assert load_kwargs["url"] == "https://example.com"
    assert load_kwargs["job_id"] == "job-xyz"

  async def test_datasource_not_found_raises_value_error(self):
    client = make_client("ing-1", [])  # no matching datasource
    jm = make_job_manager()
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      pytest.raises(ValueError, match="Datasource not found: ds-abc"),
    ):
      await process_url_ingestion(client, jm, req, "job-xyz")

  async def test_no_job_found_raises_value_error(self):
    ds = make_datasource("ds-abc", "ing-1")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([])  # no jobs
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      pytest.raises(ValueError, match="Job job-xyz does not belong to datasource ds-abc"),
    ):
      await process_url_ingestion(client, jm, req, "job-xyz")

  async def test_terminated_job_is_skipped_no_loader_called(self):
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.TERMINATED, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      await process_url_ingestion(client, jm, req, "job-xyz")

    MockLoader.assert_not_called()

  async def test_terminated_job_does_not_set_in_progress(self):
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.TERMINATED, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader"),
    ):
      await process_url_ingestion(client, jm, req, "job-xyz")

    in_progress_calls = [c for c in jm.upsert_job.call_args_list if c.kwargs.get("status") == JobStatus.IN_PROGRESS]
    assert len(in_progress_calls) == 0

  async def test_deprecated_fields_add_warning_message_to_job(self):
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.IN_PROGRESS, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com", check_for_sitemaps=True)

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await process_url_ingestion(client, jm, req, "job-xyz")

    all_messages = [c.kwargs.get("message", "") for c in jm.upsert_job.call_args_list]
    assert any("Deprecated" in m for m in all_messages)
    assert any("check_for_sitemaps" in m for m in all_messages)

  async def test_no_deprecated_fields_no_extra_upsert_job(self):
    """Without deprecated fields, exactly one upsert_job call (IN_PROGRESS at start)."""
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.IN_PROGRESS, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await process_url_ingestion(client, jm, req, "job-xyz")

    # Only one upsert_job call: the IN_PROGRESS at the start
    assert jm.upsert_job.await_count == 1

  async def test_loader_error_records_error_in_job_and_reraises(self):
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.IN_PROGRESS, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock(side_effect=RuntimeError("scrapy boom"))
      MockLoader.return_value = mock_instance

      with pytest.raises(RuntimeError, match="scrapy boom"):
        await process_url_ingestion(client, jm, req, "job-xyz")

    jm.add_error_msg.assert_awaited_once()
    job_id_arg, msg_arg = jm.add_error_msg.call_args.args
    assert job_id_arg == "job-xyz"
    assert "scrapy boom" in msg_arg

  async def test_datasource_error_is_recorded_on_exact_job(self):
    """The shared listener supplies the job id even when setup fails early."""
    client = make_client("ing-1", [])  # datasource not found → raises before job_id
    jm = make_job_manager()
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      pytest.raises(ValueError),
    ):
      await process_url_ingestion(client, jm, req, "job-xyz")

    jm.add_error_msg.assert_awaited_once()
    assert jm.add_error_msg.call_args.args[0] == "job-xyz"

  async def test_server_supplied_job_is_used(self):
    """The command's exact job wins even when another job is more recent."""
    ds = make_datasource("ds-abc", "ing-1")
    job1 = make_job("job-most-recent", JobStatus.IN_PROGRESS, "ds-abc")
    job2 = make_job("job-older", JobStatus.COMPLETED, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job1, job2])
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await process_url_ingestion(client, jm, req, "job-older")

    for c in jm.upsert_job.call_args_list:
      assert c.kwargs.get("job_id") == "job-older"

  async def test_effective_settings_passed_to_loader(self):
    """ScrapyLoader.load receives the effective (possibly remapped) settings."""
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.IN_PROGRESS, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com", check_for_sitemaps=True)

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await process_url_ingestion(client, jm, req, "job-xyz")

    load_kwargs = mock_instance.load.call_args.kwargs
    assert load_kwargs["settings"].crawl_mode == CrawlMode.SITEMAP

  async def test_add_error_msg_failure_is_silenced_original_exception_propagates(self):
    """If add_error_msg itself throws, the original exception still propagates cleanly."""
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.IN_PROGRESS, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    jm.add_error_msg = AsyncMock(side_effect=ConnectionError("redis gone"))
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock(side_effect=RuntimeError("scrapy boom"))
      MockLoader.return_value = mock_instance

      with pytest.raises(RuntimeError, match="scrapy boom"):
        await process_url_ingestion(client, jm, req, "job-xyz")

  async def test_datasource_id_derived_from_url(self):
    """generate_datasource_id_from_url is called with the exact URL from the request."""
    ds = make_datasource("expected-id", "ing-1")
    job = make_job("job-xyz", JobStatus.IN_PROGRESS, "expected-id")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://my-special-site.com/path")

    with (
      patch(
        "ingestors.webloader.ingestor.generate_datasource_id_from_url",
        return_value="expected-id",
      ) as mock_gen_id,
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await process_url_ingestion(client, jm, req, "job-xyz")

    mock_gen_id.assert_called_once_with("https://my-special-site.com/path")

  async def test_scrapy_loader_constructed_with_correct_args(self):
    ds = make_datasource("ds-abc", "ing-1")
    job = make_job("job-xyz", JobStatus.IN_PROGRESS, "ds-abc")
    client = make_client("ing-1", [ds])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-abc"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await process_url_ingestion(client, jm, req, "job-xyz")

    MockLoader.assert_called_once_with(
      rag_client=client,
      job_manager=jm,
      datasource_info=ds,
    )

  async def test_wrong_datasource_id_not_selected(self):
    """Only the datasource whose id matches the URL-derived id is used."""
    ds_wrong = make_datasource("ds-wrong", "ing-1")
    ds_right = make_datasource("ds-right", "ing-1")
    job = make_job("job-right", JobStatus.IN_PROGRESS, "ds-right")
    client = make_client("ing-1", [ds_wrong, ds_right])
    jm = make_job_manager([job])
    req = make_url_request("https://example.com")

    with (
      patch("ingestors.webloader.ingestor.generate_datasource_id_from_url", return_value="ds-right"),
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await process_url_ingestion(client, jm, req, "job-right")

    # datasource_info passed to ScrapyLoader must be ds_right
    loader_kwargs = MockLoader.call_args.kwargs
    assert loader_kwargs["datasource_info"].datasource_id == "ds-right"


# ---------------------------------------------------------------------------
# reload_datasource
# ---------------------------------------------------------------------------


class TestReloadDatasource:
  """Tests for scheduled / on-demand reload of a single datasource."""

  @staticmethod
  def _ds_with_url_request(
    datasource_id: str = "ds-1",
    url: str = "https://example.com",
    extra_meta: dict | None = None,
    check_for_sitemaps=None,
    sitemap_max_urls=None,
  ) -> DataSourceInfo:
    url_req = UrlIngestRequest(
      url=url,
      reload_interval=86400,
      check_for_sitemaps=check_for_sitemaps,
      sitemap_max_urls=sitemap_max_urls,
    ).model_dump()
    meta = {"url_ingest_request": url_req}
    if extra_meta:
      meta.update(extra_meta)
    return make_datasource(datasource_id, metadata=meta)

  async def test_happy_path_creates_job_and_runs_loader(self):
    ds = self._ds_with_url_request()
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)

    client.create_job.assert_awaited_once()
    client.upsert_datasource.assert_awaited_once()
    mock_instance.load.assert_awaited_once()
    load_kwargs = mock_instance.load.call_args.kwargs
    assert load_kwargs["url"] == "https://example.com"
    assert load_kwargs["job_id"] == "reload-job-1"

  async def test_metadata_none_returns_early_no_job_created(self):
    ds = make_datasource("ds-1", metadata=None)
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      await reload_datasource(client, jm, ds)
      MockLoader.assert_not_called()

    client.create_job.assert_not_awaited()

  async def test_empty_metadata_dict_returns_early(self):
    ds = make_datasource("ds-1", metadata={})
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      await reload_datasource(client, jm, ds)
      MockLoader.assert_not_called()

    client.create_job.assert_not_awaited()

  async def test_missing_url_ingest_request_key_returns_early(self):
    ds = make_datasource("ds-1", metadata={"some_other_key": "value"})
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      await reload_datasource(client, jm, ds)
      MockLoader.assert_not_called()

  @pytest.mark.parametrize(
    ("metadata", "message"),
    [
      (None, "No metadata"),
      ({}, "No metadata"),
      ({"some_other_key": "value"}, "No url_ingest_request"),
    ],
  )
  async def test_on_demand_reload_rejects_missing_configuration(self, metadata, message):
    """A UI-created job must fail instead of remaining pending forever."""
    ds = make_datasource("ds-1", metadata=metadata)
    client = make_client()
    jm = make_job_manager()

    with pytest.raises(ValueError, match=message):
      await reload_datasource(client, jm, ds, job_id="job-1")

    client.create_job.assert_not_awaited()

  async def test_last_updated_is_refreshed_before_loading(self):
    ds = self._ds_with_url_request()
    ds.last_updated = 0  # very old
    client = make_client()
    jm = make_job_manager()

    before = int(_time())
    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)
    after = int(_time())

    assert before <= ds.last_updated <= after
    client.upsert_datasource.assert_awaited_once_with(ds)

  async def test_deprecated_fields_in_stored_request_add_warning_to_job(self):
    ds = self._ds_with_url_request(check_for_sitemaps=True)
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)

    all_messages = [c.kwargs.get("message", "") for c in jm.upsert_job.call_args_list]
    assert any("Deprecated" in m for m in all_messages)

  async def test_loader_error_records_error_and_reraises(self):
    ds = self._ds_with_url_request()
    client = make_client()
    jm = make_job_manager()

    with (
      patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader,
      pytest.raises(RuntimeError, match="scrapy reload boom"),
    ):
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock(side_effect=RuntimeError("scrapy reload boom"))
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)

    jm.add_error_msg.assert_awaited_once()
    job_id_arg, msg_arg = jm.add_error_msg.call_args.args
    assert job_id_arg == "reload-job-1"
    assert "scrapy reload boom" in msg_arg

  async def test_job_id_passed_to_loader_matches_created_job(self):
    ds = self._ds_with_url_request()
    client = make_client()
    client.create_job = AsyncMock(return_value={"job_id": "my-unique-reload-job"})
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)

    assert mock_instance.load.call_args.kwargs["job_id"] == "my-unique-reload-job"

  async def test_effective_settings_remapped_when_deprecated_fields_present(self):
    """crawl_mode is remapped from check_for_sitemaps even during a reload."""
    ds = self._ds_with_url_request(check_for_sitemaps=True)
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)

    assert mock_instance.load.call_args.kwargs["settings"].crawl_mode == CrawlMode.SITEMAP

  async def test_sitemap_max_urls_remapped_during_reload(self):
    ds = self._ds_with_url_request(sitemap_max_urls=77)
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)

    assert mock_instance.load.call_args.kwargs["settings"].max_pages == 77

  async def test_scrapy_loader_constructed_with_correct_args(self):
    ds = self._ds_with_url_request("ds-99")
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)

    MockLoader.assert_called_once_with(
      rag_client=client,
      job_manager=jm,
      datasource_info=ds,
    )

  async def test_create_job_called_with_in_progress_and_url(self):
    ds = self._ds_with_url_request(url="https://reload-target.com")
    client = make_client()
    jm = make_job_manager()

    with patch("ingestors.webloader.ingestor.ScrapyLoader") as MockLoader:
      mock_instance = MagicMock()
      mock_instance.load = AsyncMock()
      MockLoader.return_value = mock_instance
      await reload_datasource(client, jm, ds)

    create_call_kwargs = client.create_job.call_args.kwargs
    assert create_call_kwargs["job_status"] == JobStatus.IN_PROGRESS
    from urllib.parse import urlparse as _urlparse
    _msg = create_call_kwargs["message"]
    _msg_urls = [p for p in _msg.split() if p.startswith("https://")]
    assert any(_urlparse(u).hostname == "reload-target.com" for u in _msg_urls)


# ---------------------------------------------------------------------------
# periodic_reload
# ---------------------------------------------------------------------------


class TestPeriodicReload:
  """Tests for the cron-style scheduled reload check."""

  @staticmethod
  def _fresh_ds(
    datasource_id: str = "ds-1",
    seconds_ago: int = 100,
    reload_interval: int | None = None,
  ) -> DataSourceInfo:
    """Returns a datasource that was updated `seconds_ago` seconds ago."""
    last_updated = int(_time()) - seconds_ago
    meta: dict = {"url_ingest_request": UrlIngestRequest(url="https://ex.com", reload_interval=86400).model_dump()}
    return make_datasource(datasource_id, last_updated=last_updated, metadata=meta, reload_interval=reload_interval)

  async def test_empty_datasource_list_does_nothing(self):
    client = make_client("ing-1", [])
    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      await periodic_reload(client)
    mock_reload.assert_not_awaited()

  async def test_fresh_datasource_is_skipped(self):
    """Updated 10s ago with a 86400s interval → skip."""
    ds = self._fresh_ds(seconds_ago=10, reload_interval=86400)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      await periodic_reload(client)

    mock_reload.assert_not_awaited()

  async def test_stale_datasource_is_reloaded(self):
    """Updated 90000s ago with a 86400s interval → reload."""
    ds = self._fresh_ds(seconds_ago=90000, reload_interval=86400)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      mock_reload.return_value = None
      await periodic_reload(client)

    mock_reload.assert_awaited_once()

  async def test_never_updated_datasource_is_always_reloaded(self):
    """last_updated=None means never synced → always trigger reload."""
    meta = {"url_ingest_request": UrlIngestRequest(url="https://ex.com", reload_interval=86400).model_dump()}
    ds = make_datasource("ds-1", last_updated=None, metadata=meta)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      mock_reload.return_value = None
      await periodic_reload(client)

    mock_reload.assert_awaited_once()

  async def test_uses_default_reload_interval_when_not_in_metadata_stale(self):
    """No reload_interval in metadata → uses DEFAULT_RELOAD_INTERVAL; stale → reload."""
    meta = {"url_ingest_request": UrlIngestRequest(url="https://ex.com", reload_interval=86400).model_dump()}
    ds = make_datasource(
      "ds-1",
      last_updated=int(_time()) - DEFAULT_RELOAD_INTERVAL - 1,
      metadata=meta,
    )
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      mock_reload.return_value = None
      await periodic_reload(client)

    mock_reload.assert_awaited_once()

  async def test_uses_default_reload_interval_when_not_in_metadata_fresh(self):
    """No reload_interval in metadata; updated just now → skip (default interval)."""
    meta = {"url_ingest_request": UrlIngestRequest(url="https://ex.com", reload_interval=86400).model_dump()}
    ds = make_datasource(
      "ds-1",
      last_updated=int(_time()) - 10,
      metadata=meta,
    )
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      await periodic_reload(client)

    mock_reload.assert_not_awaited()

  async def test_per_datasource_custom_interval_stale(self):
    """Custom 120s interval, 200s since last update → reload."""
    ds = self._fresh_ds(seconds_ago=200, reload_interval=120)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      mock_reload.return_value = None
      await periodic_reload(client)

    mock_reload.assert_awaited_once()

  async def test_per_datasource_custom_interval_fresh(self):
    """Custom 3600s interval, 100s since last update → skip."""
    ds = self._fresh_ds(seconds_ago=100, reload_interval=3600)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      await periodic_reload(client)

    mock_reload.assert_not_awaited()

  async def test_reload_interval_below_minimum_is_clamped_to_min_and_reloads_when_stale(self):
    """Interval < MIN_RELOAD_INTERVAL is clamped; still reloads when enough time has passed."""
    ds = self._fresh_ds(seconds_ago=MIN_RELOAD_INTERVAL + 5, reload_interval=1)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      mock_reload.return_value = None
      await periodic_reload(client)

    mock_reload.assert_awaited_once()

  async def test_reload_interval_clamped_skips_when_fresh_at_minimum(self):
    """Interval=1 clamped to MIN_RELOAD_INTERVAL; updated just now → skip."""
    ds = self._fresh_ds(seconds_ago=5, reload_interval=1)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      await periodic_reload(client)

    mock_reload.assert_not_awaited()

  async def test_minimum_reload_interval_emits_warning(self):
    ds = self._fresh_ds(seconds_ago=MIN_RELOAD_INTERVAL + 100, reload_interval=1)
    client = make_client("ing-1", [ds])

    with (
      patch("ingestors.webloader.ingestor.reload_datasource", return_value=None),
      patch("common.ingestor_listener.logger.warning") as mock_warn,
    ):
      await periodic_reload(client)

    all_warnings = " ".join(str(c) for c in mock_warn.call_args_list)
    assert "minimum" in all_warnings.lower() or str(MIN_RELOAD_INTERVAL) in all_warnings

  async def test_error_in_one_datasource_does_not_abort_others(self):
    """A reload failure for one datasource must not prevent reloading the rest."""
    ds_fail = self._fresh_ds("ds-fail", seconds_ago=90000, reload_interval=86400)
    ds_ok = self._fresh_ds("ds-ok", seconds_ago=90000, reload_interval=86400)
    client = make_client("ing-1", [ds_fail, ds_ok])

    reloaded: list[str] = []

    async def side_effect(c, jm, ds, job_id=None):
      reloaded.append(ds.datasource_id)
      if ds.datasource_id == "ds-fail":
        raise RuntimeError("boom")

    with patch("ingestors.webloader.ingestor.reload_datasource", side_effect=side_effect):
      await periodic_reload(client)  # must not propagate the error

    assert "ds-ok" in reloaded, "Second datasource must still be processed after first fails"

  async def test_all_stale_datasources_are_reloaded(self):
    datasources = [self._fresh_ds(f"ds-{i}", seconds_ago=90000, reload_interval=86400) for i in range(5)]
    client = make_client("ing-1", datasources)

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      mock_reload.return_value = None
      await periodic_reload(client)

    assert mock_reload.await_count == 5

  async def test_mix_of_fresh_and_stale_only_stale_reloaded(self):
    stale = self._fresh_ds("ds-stale", seconds_ago=90000, reload_interval=86400)
    fresh = self._fresh_ds("ds-fresh", seconds_ago=10, reload_interval=86400)
    client = make_client("ing-1", [stale, fresh])

    reloaded: list[str] = []

    async def capture(c, jm, ds, job_id=None):
      reloaded.append(ds.datasource_id)

    with patch("ingestors.webloader.ingestor.reload_datasource", side_effect=capture):
      await periodic_reload(client)

    assert reloaded == ["ds-stale"]

  async def test_datasource_with_none_metadata_skipped_gracefully(self):
    """Datasource with no metadata: reload_datasource returns early, no crash."""
    ds_no_meta = make_datasource("ds-no-meta", last_updated=0, metadata=None)
    ds_ok = self._fresh_ds("ds-ok", seconds_ago=90000, reload_interval=86400)
    client = make_client("ing-1", [ds_no_meta, ds_ok])

    reloaded: list[str] = []

    async def real_reload(c, jm, ds, job_id=None):
      if not ds.metadata:
        return
      reloaded.append(ds.datasource_id)

    with patch("ingestors.webloader.ingestor.reload_datasource", side_effect=real_reload):
      await periodic_reload(client)

    assert "ds-ok" in reloaded

  async def test_list_datasources_error_is_caught_without_propagating(self):
    """If list_datasources raises, periodic_reload handles it without propagating."""
    client = make_client("ing-1")
    client.list_datasources = AsyncMock(side_effect=ConnectionError("Redis gone"))

    await periodic_reload(client)  # must not raise

  async def test_nearly_due_but_not_yet_is_skipped(self):
    """time_since_update is (interval - 5) → NOT due yet (strict `<` comparison)."""
    interval = 3600
    # last_updated 5 seconds before the interval expires → interval-5 seconds ago
    ds = self._fresh_ds(seconds_ago=interval - 5, reload_interval=interval)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      await periodic_reload(client)

    mock_reload.assert_not_awaited()

  async def test_just_past_boundary_is_reloaded(self):
    """time_since_update is (interval + 5) → due for reload."""
    interval = 3600
    # last_updated 5 seconds after the interval expired → interval+5 seconds ago
    ds = self._fresh_ds(seconds_ago=interval + 5, reload_interval=interval)
    client = make_client("ing-1", [ds])

    with patch("ingestors.webloader.ingestor.reload_datasource") as mock_reload:
      mock_reload.return_value = None
      await periodic_reload(client)

    mock_reload.assert_awaited_once()

  async def test_job_manager_instantiated_from_redis_client(self):
    """periodic_reload creates its own JobManager from the module-level redis_client."""
    ds = self._fresh_ds(seconds_ago=90000, reload_interval=86400)
    client = make_client("ing-1", [ds])

    captured_jm = []

    async def capture(c, jm, ds_info, job_id=None):
      captured_jm.append(jm)

    with (
      patch("ingestors.webloader.ingestor.reload_datasource", side_effect=capture),
      patch("ingestors.webloader.ingestor.JobManager") as MockJM,
    ):
      mock_jm_instance = MagicMock()
      mock_jm_instance.get_jobs_by_datasource = AsyncMock(return_value=[])
      MockJM.return_value = mock_jm_instance
      await periodic_reload(client)

    MockJM.assert_called_once()
    assert captured_jm[0] is mock_jm_instance

  async def test_reload_counts_logged(self):
    """The reloaded/skipped summary is logged at INFO level."""
    stale = self._fresh_ds("ds-stale", seconds_ago=90000, reload_interval=86400)
    fresh = self._fresh_ds("ds-fresh", seconds_ago=10, reload_interval=86400)
    client = make_client("ing-1", [stale, fresh])

    with (
      patch("ingestors.webloader.ingestor.reload_datasource", return_value=None),
      patch("common.ingestor_listener.logger.info") as mock_info,
    ):
      await periodic_reload(client)

    all_info = " ".join(str(c) for c in mock_info.call_args_list)
    assert "1 reloaded" in all_info or "reloaded" in all_info
    assert "1 skipped" in all_info or "skipped" in all_info

  async def test_multiple_errors_all_datasources_attempted(self):
    """All datasources are attempted even when multiple raise exceptions."""
    datasources = [self._fresh_ds(f"ds-{i}", seconds_ago=90000, reload_interval=86400) for i in range(4)]
    client = make_client("ing-1", datasources)

    attempted: list[str] = []

    async def always_fail(c, jm, ds, job_id=None):
      attempted.append(ds.datasource_id)
      raise RuntimeError("always fails")

    with patch("ingestors.webloader.ingestor.reload_datasource", side_effect=always_fail):
      await periodic_reload(client)  # must not raise

    assert len(attempted) == 4
