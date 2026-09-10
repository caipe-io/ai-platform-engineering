"""
Simple tests for the Scrapy spiders.

These tests verify spider initialization, URL filtering logic,
and basic request generation without running actual crawls.
"""

from unittest.mock import Mock

import pytest


# ============================================================================
# Mock Objects for Testing
# ============================================================================


def make_mock_settings(
  crawl_mode: str = "single",
  max_pages: int = 100,
  max_depth: int = 2,
  render_javascript: bool = False,
  follow_external_links: bool = False,
  allowed_url_patterns: list = None,
  denied_url_patterns: list = None,
):
  """Create a mock ScrapySettings object."""
  mock = Mock()
  mock.crawl_mode = crawl_mode
  mock.max_pages = max_pages
  mock.max_depth = max_depth
  mock.render_javascript = render_javascript
  mock.follow_external_links = follow_external_links
  mock.allowed_url_patterns = allowed_url_patterns
  mock.denied_url_patterns = denied_url_patterns
  mock.wait_for_selector = None
  mock.page_load_timeout = 30
  return mock


def make_mock_client():
  """Create a mock RAG Client."""
  return Mock()


def make_mock_job_manager():
  """Create a mock JobManager."""
  return Mock()


def make_mock_datasource_info():
  """Create a mock DataSourceInfo."""
  mock = Mock()
  mock.datasource_id = "test-datasource-123"
  return mock


# ============================================================================
# ScrapedPageItem Tests
# ============================================================================


class TestScrapedPageItem:
  """Tests for the ScrapedPageItem dataclass."""

  def test_item_creation(self):
    """Should create an item with required fields."""
    from ingestors.webloader.loader.items import ScrapedPageItem

    item = ScrapedPageItem(
      url="https://example.com/page",
      content="This is the page content.",
    )

    assert item.url == "https://example.com/page"
    assert item.content == "This is the page content."
    assert item.title == ""  # Default
    assert item.description == ""  # Default

  def test_item_with_metadata(self):
    """Should create an item with all metadata fields."""
    from ingestors.webloader.loader.items import ScrapedPageItem

    item = ScrapedPageItem(
      url="https://example.com/docs",
      content="Documentation content",
      title="My Docs",
      description="Documentation description",
      language="en",
      generator="Docusaurus v2.4",
    )

    assert item.title == "My Docs"
    assert item.description == "Documentation description"
    assert item.language == "en"
    assert item.generator == "Docusaurus v2.4"

  def test_item_to_dict(self):
    """Should convert item to dictionary."""
    from ingestors.webloader.loader.items import ScrapedPageItem

    item = ScrapedPageItem(
      url="https://example.com",
      content="Content",
      title="Title",
    )

    result = item.to_dict()

    assert isinstance(result, dict)
    assert result["url"] == "https://example.com"
    assert result["content"] == "Content"
    assert result["title"] == "Title"


# ============================================================================
# URL Filtering Tests
# ============================================================================


class TestUrlFiltering:
  """Tests for URL filtering logic in spiders."""

  def test_blocks_external_links_by_default(self):
    """Spider should block external links when follow_external_links=False."""
    from ingestors.webloader.loader.spiders.base import BaseWebSpider

    spider = BaseWebSpider(
      start_url="https://docs.example.com/guide",
      scrape_settings=make_mock_settings(follow_external_links=False),
      job_id="test-job",
      client=make_mock_client(),
      job_manager=make_mock_job_manager(),
      datasource_info=make_mock_datasource_info(),
    )

    # Same domain should be allowed
    assert spider.should_follow_url("https://docs.example.com/other-page") is True

    # Different domain should be blocked
    assert spider.should_follow_url("https://other-site.com/page") is False

  def test_allows_external_links_when_enabled(self):
    """Spider should allow external links when follow_external_links=True."""
    from ingestors.webloader.loader.spiders.base import BaseWebSpider

    spider = BaseWebSpider(
      start_url="https://docs.example.com/guide",
      scrape_settings=make_mock_settings(follow_external_links=True),
      job_id="test-job",
      client=make_mock_client(),
      job_manager=make_mock_job_manager(),
      datasource_info=make_mock_datasource_info(),
    )

    assert spider.should_follow_url("https://other-site.com/page") is True

  def test_respects_allowed_patterns(self):
    """Spider should only follow URLs matching allowed patterns."""
    from ingestors.webloader.loader.spiders.base import BaseWebSpider

    spider = BaseWebSpider(
      start_url="https://docs.example.com/",
      scrape_settings=make_mock_settings(allowed_url_patterns=[r"/docs/", r"/api/"]),
      job_id="test-job",
      client=make_mock_client(),
      job_manager=make_mock_job_manager(),
      datasource_info=make_mock_datasource_info(),
    )

    # Matches /docs/
    assert spider.should_follow_url("https://docs.example.com/docs/getting-started") is True
    # Matches /api/
    assert spider.should_follow_url("https://docs.example.com/api/reference") is True
    # Doesn't match any pattern
    assert spider.should_follow_url("https://docs.example.com/blog/post") is False

  def test_respects_denied_patterns(self):
    """Spider should skip URLs matching denied patterns."""
    from ingestors.webloader.loader.spiders.base import BaseWebSpider

    spider = BaseWebSpider(
      start_url="https://docs.example.com/",
      scrape_settings=make_mock_settings(denied_url_patterns=[r"/blog/", r"\.pdf$"]),
      job_id="test-job",
      client=make_mock_client(),
      job_manager=make_mock_job_manager(),
      datasource_info=make_mock_datasource_info(),
    )

    # Should be blocked by /blog/ pattern
    assert spider.should_follow_url("https://docs.example.com/blog/post") is False
    # Should be blocked by .pdf pattern
    assert spider.should_follow_url("https://docs.example.com/files/doc.pdf") is False
    # Should be allowed
    assert spider.should_follow_url("https://docs.example.com/docs/page") is True

  def test_respects_max_pages_limit(self):
    """Spider should stop following URLs when max_pages is reached."""
    from ingestors.webloader.loader.spiders.base import BaseWebSpider

    spider = BaseWebSpider(
      start_url="https://docs.example.com/",
      scrape_settings=make_mock_settings(max_pages=10),
      job_id="test-job",
      client=make_mock_client(),
      job_manager=make_mock_job_manager(),
      datasource_info=make_mock_datasource_info(),
    )

    # Initially should allow
    assert spider.should_follow_url("https://docs.example.com/page") is True

    # Simulate reaching max pages
    spider.pages_crawled = 10

    # Should now block
    assert spider.should_follow_url("https://docs.example.com/page") is False


# ============================================================================
# Spider Initialization Tests
# ============================================================================


class TestSpiderInitialization:
  """Tests for spider initialization."""

  def test_base_spider_stores_settings(self):
    """Base spider should store all provided settings."""
    from ingestors.webloader.loader.spiders.base import BaseWebSpider

    settings = make_mock_settings(max_pages=500)
    client = make_mock_client()
    job_manager = make_mock_job_manager()
    datasource_info = make_mock_datasource_info()

    spider = BaseWebSpider(
      start_url="https://example.com",
      scrape_settings=settings,
      job_id="test-123",
      client=client,
      job_manager=job_manager,
      datasource_info=datasource_info,
    )

    assert spider.start_url == "https://example.com"
    assert spider.job_id == "test-123"
    assert spider.max_pages == 500
    assert spider.pages_crawled == 0

  def test_single_url_spider_name(self):
    """SingleUrlSpider should have correct name."""
    from ingestors.webloader.loader.spiders.single_url import SingleUrlSpider

    spider = SingleUrlSpider(
      start_url="https://example.com",
      scrape_settings=make_mock_settings(),
      job_id="test",
      client=make_mock_client(),
      job_manager=make_mock_job_manager(),
      datasource_info=make_mock_datasource_info(),
    )

    assert spider.name == "single_url_spider"

  def test_sitemap_spider_name(self):
    """SitemapCrawlSpider should have correct name."""
    from ingestors.webloader.loader.spiders.sitemap import SitemapCrawlSpider

    spider = SitemapCrawlSpider(
      start_url="https://example.com",
      scrape_settings=make_mock_settings(),
      job_id="test",
      client=make_mock_client(),
      job_manager=make_mock_job_manager(),
      datasource_info=make_mock_datasource_info(),
    )

    assert spider.name == "sitemap_spider"

  def test_recursive_spider_name(self):
    """RecursiveCrawlSpider should have correct name."""
    from ingestors.webloader.loader.spiders.recursive import RecursiveCrawlSpider

    spider = RecursiveCrawlSpider(
      start_url="https://example.com",
      scrape_settings=make_mock_settings(),
      job_id="test",
      client=make_mock_client(),
      job_manager=make_mock_job_manager(),
      datasource_info=make_mock_datasource_info(),
    )

    assert spider.name == "recursive_spider"


# ============================================================================
# WorkerSpider Redirect Handling Tests
# ============================================================================


class TestWorkerSpiderRedirectHandling:
  """Tests for WorkerSpider handling of URL redirects in recursive mode."""

  def _make_worker_spider(
    self,
    start_url: str = "https://original.com",
    crawl_mode: str = "recursive",
    follow_external: bool = False,
  ):
    """Create a WorkerSpider instance for testing."""
    from ingestors.webloader.loader.scrapy_worker import WorkerSpider
    from ingestors.webloader.loader.worker_types import CrawlRequest
    from multiprocessing import Queue

    request = CrawlRequest(
      job_id="test-job",
      url=start_url,
      datasource_id="test-ds",
      crawl_mode=crawl_mode,
      follow_external_links=follow_external,
      max_pages=100,
    )
    result_queue = Queue()

    spider = WorkerSpider(request=request, result_queue=result_queue)
    return spider

  def test_effective_domain_initially_none(self):
    """WorkerSpider should have effective_domain=None initially."""
    spider = self._make_worker_spider()
    assert spider.effective_domain is None

  def test_sets_scrapy_start_urls_for_current_scrapy(self):
    """WorkerSpider should satisfy Scrapy's default start() validation."""
    spider = self._make_worker_spider(start_url="https://docs.example.com")

    assert spider.start_urls == ["https://docs.example.com"]

  @pytest.mark.asyncio
  async def test_async_start_uses_mode_specific_start_requests(self):
    """WorkerSpider should not let Scrapy default to parse() for start URLs."""
    spider = self._make_worker_spider(start_url="https://example.com/", crawl_mode="sitemap")
    # URL safety has dedicated tests below. Keep this request-generation test
    # deterministic and independent from live DNS/network access.
    spider._is_safe_crawl_url = Mock(return_value=True)

    requests = [request async for request in spider.start()]

    assert len(requests) == 1
    assert requests[0].url == "https://example.com/sitemap.xml"
    assert requests[0].callback == spider.parse_sitemap

  def test_should_follow_uses_start_domain_when_no_redirect(self):
    """Without redirect, _should_follow should use start_url domain."""
    spider = self._make_worker_spider(start_url="https://docs.example.com")

    # Same domain should be allowed
    assert spider._should_follow("https://docs.example.com/page1", track_filtering=False) is True

    # Different domain should be blocked
    assert spider._should_follow("https://other.com/page", track_filtering=False) is False

  def test_should_follow_uses_effective_domain_after_redirect(self):
    """After redirect, _should_follow should use effective_domain."""
    spider = self._make_worker_spider(start_url="https://original.com")

    # Simulate a redirect by setting effective_domain (as parse_page would)
    spider.effective_domain = "redirected.com"

    # Link on redirected domain should be allowed
    assert spider._should_follow("https://redirected.com/page", track_filtering=False) is True

    # Link on original domain should now be blocked (it's external to where we are)
    assert spider._should_follow("https://original.com/page", track_filtering=False) is False

  def test_parse_page_sets_effective_domain_on_redirect(self):
    """parse_page should set effective_domain when response URL differs from start_url."""
    spider = self._make_worker_spider(start_url="https://legacy.example.com")

    # Create a mock response that simulates landing on a different domain after redirect
    mock_response = Mock()
    mock_response.url = "https://docs.example.com/"
    mock_response.status = 200
    mock_response.text = "<html><body>Content</body></html>"
    mock_response.css = Mock(return_value=Mock(getall=Mock(return_value=[])))

    # Initially effective_domain should be None
    assert spider.effective_domain is None

    # Consume the generator (parse_page is a generator due to yield statements)
    list(spider.parse_page(mock_response))

    # After parse_page, effective_domain should be set to the response domain
    assert spider.effective_domain == "docs.example.com"

  def test_parse_page_does_not_change_effective_domain_if_same(self):
    """parse_page should not set effective_domain if response domain matches start domain."""
    spider = self._make_worker_spider(start_url="https://docs.example.com")

    mock_response = Mock()
    mock_response.url = "https://docs.example.com/page"
    mock_response.status = 200
    mock_response.text = "<html><body>Content</body></html>"
    mock_response.css = Mock(return_value=Mock(getall=Mock(return_value=[])))

    # Consume the generator
    list(spider.parse_page(mock_response))

    # effective_domain should remain None since no redirect occurred
    assert spider.effective_domain is None

  def test_legacy_host_redirects_to_canonical_domain(self):
    """A crawl should follow links on the canonical domain after redirecting from a legacy host."""
    spider = self._make_worker_spider(start_url="https://legacy.example.com", crawl_mode="recursive")

    # Before any redirect handling
    # A link to the canonical domain should be blocked before the redirect is detected.
    assert spider._should_follow("https://docs.example.com/guide/", track_filtering=False) is False

    # Simulate parse_page detecting the redirect
    spider.effective_domain = "docs.example.com"

    # Now the same link should be allowed
    assert spider._should_follow("https://docs.example.com/guide/", track_filtering=False) is True

    # Links to original domain should now be blocked
    assert spider._should_follow("https://legacy.example.com/some-page", track_filtering=False) is False

  def test_should_follow_blocks_private_ip_even_when_external_links_enabled(self):
    """WorkerSpider should not schedule internal or metadata-service URLs."""
    spider = self._make_worker_spider(start_url="https://docs.example.com", follow_external=True)

    assert spider._should_follow("http://169.254.169.254/latest/meta-data", track_filtering=False) is False

  def test_start_requests_blocks_private_start_url(self):
    """WorkerSpider should reject an unsafe initial crawl URL before Scrapy fetches it."""
    spider = self._make_worker_spider(start_url="http://169.254.169.254/latest/meta-data", follow_external=True)

    requests = list(spider.start_requests())

    assert requests == []
    assert spider.pages_failed == 1
    assert any("publicly routable" in error for error in spider.errors)

  def test_downloader_middleware_blocks_private_redirect_targets(self):
    """Downloader middleware should block unsafe requests created by Scrapy redirects."""
    from scrapy import Request
    from scrapy.exceptions import IgnoreRequest
    from ingestors.webloader.loader.scrapy_worker import SSRFProtectionMiddleware

    middleware = SSRFProtectionMiddleware()
    spider = self._make_worker_spider(start_url="https://docs.example.com", follow_external=True)

    with pytest.raises(IgnoreRequest, match="publicly routable"):
      middleware.process_request(Request("http://169.254.169.254/latest/meta-data"), spider)

  def test_downloader_middleware_allows_public_urls(self):
    """Downloader middleware should return None (pass through) for public URLs."""
    from scrapy import Request
    from ingestors.webloader.loader.scrapy_worker import SSRFProtectionMiddleware
    from unittest.mock import patch

    middleware = SSRFProtectionMiddleware()
    spider = self._make_worker_spider(start_url="https://docs.example.com", follow_external=True)

    with patch("ingestors.webloader.loader.scrapy_worker.is_publicly_routable_url", return_value=(True, "")):
      result = middleware.process_request(Request("https://docs.example.com/page"), spider)

    assert result is None

  def test_build_spider_settings_registers_ssrf_middleware(self):
    """Scrapy settings should install the SSRF middleware for all downloads."""
    from ingestors.webloader.loader.scrapy_worker import build_spider_settings
    from ingestors.webloader.loader.worker_types import CrawlRequest

    settings = build_spider_settings(
      CrawlRequest(
        job_id="test-job",
        url="https://docs.example.com",
        datasource_id="test-ds",
        crawl_mode="single",
      )
    )

    assert settings["DOWNLOADER_MIDDLEWARES"]["ingestors.webloader.loader.scrapy_worker.SSRFProtectionMiddleware"] == 543


# ============================================================================
# WorkerSpider Sitemap Index Handling Tests
# ============================================================================


class TestParseSitemapIndex:
  """Tests for WorkerSpider.parse_sitemap distinguishing a sitemap index from a urlset.

  Regression coverage for a real ingestion failure on outshift.cisco.com: its
  sitemap.xml is a <sitemapindex> listing three child sitemaps, not a page
  list. parse_sitemap used to extract those child-sitemap <loc> URLs and
  dispatch them straight to parse_page, which fetched the XML "successfully"
  but extracted zero content, reporting "3 URLs found in sitemap, 0 scraped".
  """

  SITEMAP_INDEX = """<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://outshift.cisco.com/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://outshift.cisco.com/sitemap-blogs.xml</loc></sitemap>
  <sitemap><loc>https://outshift.cisco.com/sitemap-events.xml</loc></sitemap>
</sitemapindex>"""

  PAGES_URLSET = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://outshift.cisco.com/</loc></url>
  <url><loc>https://outshift.cisco.com/about-us</loc></url>
  <url><loc>https://outshift.cisco.com/careers</loc></url>
</urlset>"""

  BLOGS_URLSET = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://outshift.cisco.com/blog/post-1</loc></url>
</urlset>"""

  def _make_worker_spider(self, max_pages: int = 100):
    """Create a WorkerSpider instance for testing."""
    from ingestors.webloader.loader.scrapy_worker import WorkerSpider
    from ingestors.webloader.loader.worker_types import CrawlRequest
    from multiprocessing import Queue

    request = CrawlRequest(
      job_id="test-job",
      url="https://outshift.cisco.com",
      datasource_id="test-ds",
      crawl_mode="sitemap",
      max_pages=max_pages,
    )
    result_queue = Queue()

    return WorkerSpider(request=request, result_queue=result_queue)

  def _make_sitemap_response(self, url: str, text: str):
    """Create a mock Response for parse_sitemap, with no redirect (response.url == response.request.url)."""
    mock_response = Mock()
    mock_response.url = url
    mock_response.status = 200
    mock_response.text = text
    mock_response.meta = {}
    mock_response.request = Mock()
    mock_response.request.url = url
    return mock_response

  def test_sitemap_index_recurses_into_child_sitemaps_instead_of_scraping_them(self):
    """A <sitemapindex> root should fan out to each child sitemap via parse_sitemap, not parse_page."""
    from unittest.mock import patch

    spider = self._make_worker_spider()
    response = self._make_sitemap_response("https://outshift.cisco.com/sitemap.xml", self.SITEMAP_INDEX)

    with patch("ingestors.webloader.loader.scrapy_worker.is_publicly_routable_url", return_value=(True, "")):
      requests = list(spider.parse_sitemap(response))

    assert len(requests) == 3
    assert {r.url for r in requests} == {
      "https://outshift.cisco.com/sitemap-pages.xml",
      "https://outshift.cisco.com/sitemap-blogs.xml",
      "https://outshift.cisco.com/sitemap-events.xml",
    }
    assert all(r.callback == spider.parse_sitemap for r in requests)

    # The index itself lists no pages - nothing should be counted as crawlable yet.
    assert spider.urls_found_in_sitemap == 0
    assert spider.total_pages_to_crawl is None

  def test_child_urlset_dispatches_to_parse_page_and_totals_accumulate_across_children(self):
    """A <urlset> reached via the index is a real page list; totals must accumulate, not overwrite, across siblings."""
    from unittest.mock import patch

    spider = self._make_worker_spider()

    with patch("ingestors.webloader.loader.scrapy_worker.is_publicly_routable_url", return_value=(True, "")):
      index_response = self._make_sitemap_response("https://outshift.cisco.com/sitemap.xml", self.SITEMAP_INDEX)
      list(spider.parse_sitemap(index_response))

      pages_response = self._make_sitemap_response("https://outshift.cisco.com/sitemap-pages.xml", self.PAGES_URLSET)
      page_requests = list(spider.parse_sitemap(pages_response))

      assert len(page_requests) == 3
      assert all(r.callback == spider.parse_page for r in page_requests)
      assert spider.urls_found_in_sitemap == 3
      assert spider.total_pages_to_crawl == 3

      # A second child sitemap must add to the running total, not reset it.
      blogs_response = self._make_sitemap_response("https://outshift.cisco.com/sitemap-blogs.xml", self.BLOGS_URLSET)
      list(spider.parse_sitemap(blogs_response))

    assert spider.urls_found_in_sitemap == 4
    assert spider.total_pages_to_crawl == 4


class TestParseSitemapFlatUrlset:
  """Tests for parse_sitemap against a representative non-indexed sitemap.

  Docusaurus generates a flat <urlset> with namespace, changefreq, and priority
  attributes. This guards against the sitemapindex check ever misfiring on an
  ordinary, larger sitemap.
  """

  # A representative Docusaurus sitemap excerpt with namespace and per-URL tags intact.
  REPRESENTATIVE_FLAT_URLSET = """<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"><url><loc>https://docs.example.com/blog</loc><changefreq>weekly</changefreq><priority>0.5</priority></url><url><loc>https://docs.example.com/blog/example-post</loc><changefreq>weekly</changefreq><priority>0.5</priority></url><url><loc>https://docs.example.com/docs/getting-started/kind/setup</loc><changefreq>weekly</changefreq><priority>0.5</priority></url><url><loc>https://docs.example.com/docs/features</loc><changefreq>weekly</changefreq><priority>0.5</priority></url><url><loc>https://docs.example.com/</loc><changefreq>weekly</changefreq><priority>0.5</priority></url></urlset>"""

  def _make_worker_spider(self, max_pages: int = 100):
    """Create a WorkerSpider instance for testing."""
    from ingestors.webloader.loader.scrapy_worker import WorkerSpider
    from ingestors.webloader.loader.worker_types import CrawlRequest
    from multiprocessing import Queue

    request = CrawlRequest(
      job_id="test-job",
      url="https://docs.example.com/",
      datasource_id="test-ds",
      crawl_mode="sitemap",
      max_pages=max_pages,
    )
    result_queue = Queue()

    return WorkerSpider(request=request, result_queue=result_queue)

  def _make_sitemap_response(self, url: str, text: str):
    """Create a mock Response for parse_sitemap, with no redirect (response.url == response.request.url)."""
    mock_response = Mock()
    mock_response.url = url
    mock_response.status = 200
    mock_response.text = text
    mock_response.meta = {}
    mock_response.request = Mock()
    mock_response.request.url = url
    return mock_response

  def test_representative_flat_urlset_is_not_treated_as_an_index(self):
    """A namespaced Docusaurus <urlset> must dispatch straight to parse_page, not recurse."""
    from unittest.mock import patch

    spider = self._make_worker_spider()
    response = self._make_sitemap_response(
      "https://docs.example.com/sitemap.xml", self.REPRESENTATIVE_FLAT_URLSET
    )

    with patch("ingestors.webloader.loader.scrapy_worker.is_publicly_routable_url", return_value=(True, "")):
      requests = list(spider.parse_sitemap(response))

    assert len(requests) == 5
    assert all(r.callback == spider.parse_page for r in requests)
    assert spider.urls_found_in_sitemap == 5
    assert spider.total_pages_to_crawl == 5

  def test_representative_flat_urlset_respects_max_pages_truncation(self):
    """For a larger flat sitemap, max_pages must still cap what gets queued."""
    from unittest.mock import patch

    spider = self._make_worker_spider(max_pages=3)
    response = self._make_sitemap_response(
      "https://docs.example.com/sitemap.xml", self.REPRESENTATIVE_FLAT_URLSET
    )

    with patch("ingestors.webloader.loader.scrapy_worker.is_publicly_routable_url", return_value=(True, "")):
      requests = list(spider.parse_sitemap(response))

    assert len(requests) == 3
    assert spider.total_pages_to_crawl == 3


class TestParseSitemapFilteringOrder:
  """Regression coverage for applying sitemap URL filters before page limits."""

  def test_allow_pattern_can_select_urls_after_preview_limit(self):
    """A route later in a sitemap remains previewable when earlier routes do not match."""
    from multiprocessing import Queue
    from unittest.mock import patch

    from ingestors.webloader.loader.scrapy_worker import WorkerSpider
    from ingestors.webloader.loader.worker_types import CrawlRequest

    excluded_urls = "".join(
      f"<url><loc>https://docs.example.com/blog/post-{index}</loc></url>"
      for index in range(100)
    )
    matching_urls = "".join(
      f"<url><loc>https://docs.example.com/docs/1.2/page-{index}</loc></url>"
      for index in range(3)
    )
    sitemap = f"<urlset>{excluded_urls}{matching_urls}</urlset>"
    request = CrawlRequest(
      job_id="test-job",
      url="https://docs.example.com/",
      datasource_id="test-ds",
      crawl_mode="sitemap",
      max_pages=2,
      allowed_url_patterns=[r"^https://docs\.example\.com/docs/1\.2/.*$"],
    )
    spider = WorkerSpider(request=request, result_queue=Queue())
    response = Mock(
      url="https://docs.example.com/sitemap.xml",
      status=200,
      text=sitemap,
      meta={},
      request=Mock(url="https://docs.example.com/sitemap.xml"),
    )

    with patch(
      "ingestors.webloader.loader.scrapy_worker.is_publicly_routable_url",
      return_value=(True, ""),
    ):
      requests = list(spider.parse_sitemap(response))

    assert [request.url for request in requests] == [
      "https://docs.example.com/docs/1.2/page-0",
      "https://docs.example.com/docs/1.2/page-1",
    ]
    assert spider.urls_found_in_sitemap == 103
    assert spider.urls_matched_in_sitemap == 3
    assert spider.urls_filtered_pattern == 100
    assert spider.urls_filtered_max_pages == 1


# ============================================================================
# WorkerSpider Streaming and Cancellation Tests
# ============================================================================


class TestWorkerSpiderStreaming:
  """Tests for WorkerSpider batch streaming functionality."""

  def _make_worker_spider(
    self,
    start_url: str = "https://example.com",
    crawl_mode: str = "recursive",
    max_pages: int = 100,
  ):
    """Create a WorkerSpider instance for testing."""
    from ingestors.webloader.loader.scrapy_worker import WorkerSpider
    from ingestors.webloader.loader.worker_types import CrawlRequest
    from multiprocessing import Queue

    request = CrawlRequest(
      job_id="test-job",
      url=start_url,
      datasource_id="test-ds",
      crawl_mode=crawl_mode,
      max_pages=max_pages,
    )
    result_queue = Queue()

    spider = WorkerSpider(request=request, result_queue=result_queue)
    return spider

  def test_spider_has_batch_size_setting(self):
    """WorkerSpider should have a batch_size setting."""
    spider = self._make_worker_spider()
    # batch_size should be set to a reasonable default
    assert hasattr(spider, "batch_size")
    assert spider.batch_size > 0

  def test_spider_has_cancelled_flag(self):
    """WorkerSpider should have a _cancelled flag."""
    spider = self._make_worker_spider()
    assert hasattr(spider, "_cancelled")
    assert spider._cancelled is False

  def test_cancel_sets_flag(self):
    """cancel() should set the _cancelled flag."""
    spider = self._make_worker_spider()

    spider.cancel()

    assert spider._cancelled is True

  def test_document_batch_tracking(self):
    """WorkerSpider should track documents in batches."""
    spider = self._make_worker_spider()
    # Should have document batch list and counter
    assert hasattr(spider, "documents_in_current_batch")
    assert hasattr(spider, "batch_number")
    assert spider.batch_number == 0


class TestWorkerSpiderCancellation:
  """Tests for WorkerSpider cancellation during crawl."""

  def _make_worker_spider(self, start_url: str = "https://example.com"):
    """Create a WorkerSpider instance for testing."""
    from ingestors.webloader.loader.scrapy_worker import WorkerSpider
    from ingestors.webloader.loader.worker_types import CrawlRequest
    from multiprocessing import Queue

    request = CrawlRequest(
      job_id="test-job",
      url=start_url,
      datasource_id="test-ds",
      crawl_mode="recursive",
      max_pages=100,
    )
    result_queue = Queue()

    spider = WorkerSpider(request=request, result_queue=result_queue)
    return spider

  def test_parse_page_exits_early_when_cancelled(self):
    """parse_page should exit early if spider is cancelled."""
    spider = self._make_worker_spider()

    # Set cancelled flag
    spider._cancelled = True

    # Create a mock response
    mock_response = Mock()
    mock_response.url = "https://example.com/page"
    mock_response.status = 200
    mock_response.text = "<html><body>Content</body></html>"

    # parse_page should yield nothing when cancelled
    results = list(spider.parse_page(mock_response))

    # Should be empty (no documents, no follow links)
    assert len(results) == 0


class TestCrawlDocumentsMessage:
  """Tests for CrawlDocuments message type."""

  def test_crawl_documents_creation(self):
    """CrawlDocuments should store batch info correctly."""
    from ingestors.webloader.loader.worker_types import CrawlDocuments

    docs = CrawlDocuments(
      job_id="test-job",
      documents=[{"id": "doc1", "page_content": "content", "metadata": {}}],
      batch_number=1,
      is_final_batch=False,
    )

    assert docs.job_id == "test-job"
    assert len(docs.documents) == 1
    assert docs.batch_number == 1
    assert docs.is_final_batch is False

  def test_crawl_documents_final_batch(self):
    """CrawlDocuments should track final batch correctly."""
    from ingestors.webloader.loader.worker_types import CrawlDocuments

    docs = CrawlDocuments(
      job_id="test-job",
      documents=[],
      batch_number=5,
      is_final_batch=True,
    )

    assert docs.is_final_batch is True


class TestWorkerMessageCancelCrawl:
  """Tests for CANCEL_CRAWL message type."""

  def test_cancel_crawl_message_creation(self):
    """WorkerMessage.cancel_crawl should create correct message."""
    from ingestors.webloader.loader.worker_types import WorkerMessage, MessageType

    msg = WorkerMessage.cancel_crawl("job-123")

    assert msg.type == MessageType.CANCEL_CRAWL
    assert msg.payload["job_id"] == "job-123"

  def test_cancel_crawl_message_serialization(self):
    """CANCEL_CRAWL message should serialize/deserialize correctly."""
    from ingestors.webloader.loader.worker_types import WorkerMessage, MessageType

    msg = WorkerMessage.cancel_crawl("job-456")
    msg_dict = msg.to_dict()

    # Should serialize to dict
    assert msg_dict["type"] == "cancel_crawl"
    assert msg_dict["payload"]["job_id"] == "job-456"

    # Should deserialize back
    restored = WorkerMessage.from_dict(msg_dict)
    assert restored.type == MessageType.CANCEL_CRAWL
    assert restored.payload["job_id"] == "job-456"


class TestWorkerMessageCrawlDocuments:
  """Tests for CRAWL_DOCUMENTS message type."""

  def test_crawl_documents_message_creation(self):
    """WorkerMessage.crawl_documents should create correct message."""
    from ingestors.webloader.loader.worker_types import WorkerMessage, MessageType, CrawlDocuments

    docs = CrawlDocuments(
      job_id="job-789",
      documents=[{"id": "d1", "page_content": "test", "metadata": {}}],
      batch_number=2,
      is_final_batch=False,
    )
    msg = WorkerMessage.crawl_documents(docs)

    assert msg.type == MessageType.CRAWL_DOCUMENTS
    assert msg.payload["job_id"] == "job-789"
    assert len(msg.payload["documents"]) == 1
    assert msg.payload["batch_number"] == 2
    assert msg.payload["is_final_batch"] is False

  def test_crawl_documents_message_serialization(self):
    """CRAWL_DOCUMENTS message should serialize/deserialize correctly."""
    from ingestors.webloader.loader.worker_types import WorkerMessage, MessageType, CrawlDocuments

    docs = CrawlDocuments(
      job_id="job-999",
      documents=[{"id": "d1", "page_content": "hello", "metadata": {"source": "test"}}],
      batch_number=3,
      is_final_batch=True,
    )
    msg = WorkerMessage.crawl_documents(docs)
    msg_dict = msg.to_dict()

    # Should serialize
    assert msg_dict["type"] == "crawl_documents"

    # Should deserialize
    restored = WorkerMessage.from_dict(msg_dict)
    assert restored.type == MessageType.CRAWL_DOCUMENTS
    assert restored.payload["job_id"] == "job-999"
    assert restored.payload["is_final_batch"] is True


class TestWorkerSpiderPlaywrightMeta:
  """Tests for Playwright meta configuration in WorkerSpider."""

  def _make_worker_spider(self, render_javascript: bool = False, wait_for_selector: str = None):
    """Create a WorkerSpider instance for testing."""
    from ingestors.webloader.loader.scrapy_worker import WorkerSpider
    from ingestors.webloader.loader.worker_types import CrawlRequest
    from multiprocessing import Queue

    request = CrawlRequest(
      job_id="test-job",
      url="https://example.com",
      datasource_id="test-ds",
      crawl_mode="single",
      max_pages=100,
      render_javascript=render_javascript,
      wait_for_selector=wait_for_selector,
      page_load_timeout=30,
    )
    result_queue = Queue()

    spider = WorkerSpider(request=request, result_queue=result_queue)
    return spider

  def test_build_request_meta_without_js_rendering(self):
    """_build_request_meta should return empty dict when JS rendering disabled."""
    spider = self._make_worker_spider(render_javascript=False)

    meta = spider._build_request_meta()

    assert "playwright" not in meta
    assert meta == {}

  def test_build_request_meta_with_js_rendering(self):
    """_build_request_meta should include Playwright settings when JS rendering enabled."""
    import pytest

    try:
      import scrapy_playwright  # noqa: F401
    except ImportError:
      pytest.skip("scrapy_playwright not installed")

    spider = self._make_worker_spider(render_javascript=True)

    meta = spider._build_request_meta()

    assert meta.get("playwright") is True
    assert "playwright_page_methods" in meta
    # Should have at least the networkidle wait
    assert len(meta["playwright_page_methods"]) >= 1

  def test_build_request_meta_with_wait_for_selector(self):
    """_build_request_meta should include wait_for_selector when configured."""
    import pytest

    try:
      import scrapy_playwright  # noqa: F401
    except ImportError:
      pytest.skip("scrapy_playwright not installed")

    spider = self._make_worker_spider(render_javascript=True, wait_for_selector="#main-content")

    meta = spider._build_request_meta()

    assert meta.get("playwright") is True
    # Should have 2 page methods: wait_for_selector + networkidle
    assert len(meta["playwright_page_methods"]) == 2

  def test_build_request_meta_preserves_extra_meta(self):
    """_build_request_meta should preserve extra meta fields."""
    spider = self._make_worker_spider(render_javascript=False)

    meta = spider._build_request_meta(base_url="https://example.com", custom_field="value")

    assert meta["base_url"] == "https://example.com"
    assert meta["custom_field"] == "value"

  def test_build_request_meta_combines_playwright_with_extra_meta(self):
    """_build_request_meta should combine Playwright settings with extra meta."""
    import pytest

    try:
      import scrapy_playwright  # noqa: F401
    except ImportError:
      pytest.skip("scrapy_playwright not installed")

    spider = self._make_worker_spider(render_javascript=True)

    meta = spider._build_request_meta(base_url="https://example.com")

    assert meta["base_url"] == "https://example.com"
    assert meta.get("playwright") is True
