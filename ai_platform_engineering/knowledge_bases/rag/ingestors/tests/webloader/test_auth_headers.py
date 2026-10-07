"""
Tests for authenticated web ingestion.

Covers auth header validation, origin-scoped header attachment, and the
credential-aware failure messages.
"""

from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from common.models.server import AuthHeader, CrawlMode, ScrapySettings

from ingestors.webloader.loader.scrapy_worker import (
  AuthHeaderMiddleware,
  _origin_key,
  build_spider_settings,
)
from ingestors.webloader.loader.worker_types import CrawlRequest


# ============================================================================
# AuthHeader validation
# ============================================================================


def test_render_substitutes_the_placeholder():
  header = AuthHeader(header_name="Authorization", value_template="Bearer {{secret}}", secret_ref="docs-token")
  assert header.render("abc123") == "Bearer abc123"


@pytest.mark.parametrize(
  "template,secret,expected",
  [
    ("{{secret}}", "raw-key", "raw-key"),
    ("Bearer {{secret}}", "t", "Bearer t"),
    ("token {{secret}}", "t", "token t"),
    ("Basic {{secret}}", "dXNlcjpwdw==", "Basic dXNlcjpwdw=="),
  ],
)
def test_render_supports_arbitrary_schemes(template, secret, expected):
  header = AuthHeader(header_name="Authorization", value_template=template, secret_ref="ref")
  assert header.render(secret) == expected


def test_template_without_placeholder_is_rejected():
  with pytest.raises(ValidationError):
    AuthHeader(header_name="Authorization", value_template="Bearer static", secret_ref="ref")


@pytest.mark.parametrize("template", ["Bearer {{secret}}\r\nX-Evil: 1", "Bearer {{secret}}\ninjected"])
def test_line_breaks_in_template_are_rejected(template):
  with pytest.raises(ValidationError):
    AuthHeader(header_name="Authorization", value_template=template, secret_ref="ref")


@pytest.mark.parametrize("name", ["Auth orization", "Bad:Name", "has\nnewline", ""])
def test_invalid_header_names_are_rejected(name):
  with pytest.raises(ValidationError):
    AuthHeader(header_name=name, value_template="{{secret}}", secret_ref="ref")


def test_placeholder_without_a_credential_is_rejected():
  with pytest.raises(ValidationError):
    AuthHeader(header_name="Authorization", value_template="{{secret}}", secret_ref="   ")


def test_static_header_needs_no_credential():
  header = AuthHeader(header_name="X-Environment", value_template="staging")
  assert header.secret_ref is None
  assert header.render() == "staging"


def test_static_header_ignores_a_supplied_secret():
  header = AuthHeader(header_name="X-Environment", value_template="staging")
  assert header.render("unused") == "staging"


def test_empty_value_is_rejected():
  with pytest.raises(ValidationError):
    AuthHeader(header_name="X-Environment", value_template="   ")


def test_credential_header_without_a_secret_raises_at_render():
  header = AuthHeader(header_name="Authorization", value_template="Bearer {{secret}}", secret_ref="ref")
  with pytest.raises(ValueError):
    header.render()


def test_static_and_credential_headers_coexist():
  settings = ScrapySettings(
    auth_headers=[
      AuthHeader(header_name="Authorization", value_template="Bearer {{secret}}", secret_ref="a"),
      AuthHeader(header_name="X-Environment", value_template="staging"),
    ]
  )
  assert [header.secret_ref for header in settings.auth_headers] == ["a", None]


def test_duplicate_header_names_are_rejected():
  with pytest.raises(ValidationError):
    ScrapySettings(
      auth_headers=[
        AuthHeader(header_name="Authorization", value_template="{{secret}}", secret_ref="a"),
        AuthHeader(header_name="authorization", value_template="{{secret}}", secret_ref="b"),
      ]
    )


def test_distinct_header_names_are_accepted():
  settings = ScrapySettings(
    auth_headers=[
      AuthHeader(header_name="Authorization", value_template="Bearer {{secret}}", secret_ref="a"),
      AuthHeader(header_name="X-Api-Key", value_template="{{secret}}", secret_ref="b"),
    ]
  )
  assert len(settings.auth_headers) == 2


def test_auth_headers_default_to_absent():
  assert ScrapySettings().auth_headers is None


# ============================================================================
# Origin key normalization
# ============================================================================


@pytest.mark.parametrize(
  "a,b",
  [
    ("https://docs.example.com/", "https://docs.example.com:443/other"),
    ("http://docs.example.com/", "http://docs.example.com:80/other"),
    ("https://Docs.Example.Com/", "https://docs.example.com/"),
  ],
)
def test_origin_key_normalizes_default_ports_and_case(a, b):
  assert _origin_key(a) == _origin_key(b)


@pytest.mark.parametrize(
  "a,b",
  [
    ("https://docs.example.com/", "http://docs.example.com/"),
    ("https://docs.example.com/", "https://docs.example.com:8443/"),
    ("https://docs.example.com/", "https://assets.docs.example.com/"),
  ],
)
def test_origin_key_distinguishes_scheme_port_and_host(a, b):
  assert _origin_key(a) != _origin_key(b)


def test_origin_key_rejects_url_with_no_scheme_or_host():
  assert _origin_key("not-a-url") is None


# ============================================================================
# Origin-scoped header attachment
# ============================================================================


def make_spider(origin=("https", "docs.example.com", 443), headers: dict | None = None):
  spider = Mock()
  spider.auth_origin = origin
  spider.auth_headers = headers if headers is not None else {"Authorization": "Bearer secret-value"}
  return spider


def make_request(url: str):
  request = Mock()
  request.url = url
  request.headers = {}
  return request


@pytest.mark.parametrize(
  "url",
  [
    "https://docs.example.com/",
    "https://docs.example.com/guide/page.html",
    "https://docs.example.com:443/explicit-default-port",
  ],
)
def test_header_is_attached_for_the_exact_origin(url):
  middleware = AuthHeaderMiddleware()
  request = make_request(url)
  middleware.process_request(request, make_spider())
  assert request.headers["Authorization"] == "Bearer secret-value"


@pytest.mark.parametrize(
  "url",
  [
    "https://example.com/",
    "https://auth.example.org/login",
    "https://docs.example.com.evil.test/",
    "https://other-docs.example.net/",
    # A subdomain of the origin is a different origin, not a trusted alias.
    "https://assets.docs.example.com/style.css",
    # Scheme downgrade must never carry a bearer credential over plaintext.
    "http://docs.example.com/plain",
    # A different port is a different origin even on the same host/scheme.
    "https://docs.example.com:8443/",
  ],
)
def test_header_is_withheld_off_origin(url):
  middleware = AuthHeaderMiddleware()
  request = make_request(url)
  middleware.process_request(request, make_spider())
  assert "Authorization" not in request.headers


def test_header_already_present_off_origin_is_stripped_not_left_alone():
  # Simulates what Scrapy's own RedirectMiddleware does: it clones every
  # header from the original request onto the redirected one, then only
  # knows to remove Authorization/Cookie itself. A custom header name must
  # be actively stripped here, not merely skipped, or it survives the clone.
  middleware = AuthHeaderMiddleware()
  request = make_request("https://attacker.test/")
  request.headers["X-Api-Key"] = "leaked-if-not-stripped"
  middleware.process_request(request, make_spider(headers={"X-Api-Key": "k"}))
  assert "X-Api-Key" not in request.headers


def test_no_headers_configured_is_a_noop():
  middleware = AuthHeaderMiddleware()
  request = make_request("https://docs.example.com/")
  middleware.process_request(request, make_spider(headers={}))
  assert request.headers == {}


def test_missing_origin_withholds_headers():
  middleware = AuthHeaderMiddleware()
  request = make_request("https://docs.example.com/")
  middleware.process_request(request, make_spider(origin=None))
  assert request.headers == {}


def test_attachment_works_on_a_real_scrapy_request():
  from scrapy import Request

  middleware = AuthHeaderMiddleware()
  spider = make_spider(headers={"Authorization": "Bearer secret-value", "X-Api-Key": "k"})

  on_origin = Request("https://docs.example.com/page")
  middleware.process_request(on_origin, spider)
  assert on_origin.headers.get("Authorization") == b"Bearer secret-value"
  assert on_origin.headers.get("X-Api-Key") == b"k"

  off_origin = Request("https://other.test/page")
  middleware.process_request(off_origin, spider)
  assert off_origin.headers.get("Authorization") is None


def test_custom_header_does_not_survive_a_real_redirect_off_origin():
  """End-to-end reproduction of the leak this middleware exists to close.

  Scrapy's RedirectMiddleware builds the redirected request by cloning the
  original one (headers included) and only strips Authorization/Cookie
  itself. A custom header name has nowhere else to be removed.
  """
  from scrapy import Request
  from scrapy.downloadermiddlewares.redirect import RedirectMiddleware
  from scrapy.http import Response

  middleware = AuthHeaderMiddleware()
  spider = make_spider(headers={"X-Api-Key": "k"})

  original = Request("https://docs.example.com/page")
  middleware.process_request(original, spider)
  assert original.headers.get("X-Api-Key") == b"k"

  response = Response(
    "https://docs.example.com/page",
    status=302,
    headers={"Location": "https://attacker.test/steal"},
    request=original,
  )
  redirect_middleware = RedirectMiddleware.__new__(RedirectMiddleware)
  redirect_middleware._referer_spider_middleware = None
  redirected = RedirectMiddleware._build_redirect_request(
    redirect_middleware,
    original,
    response,
    url="https://attacker.test/steal",
  )
  assert redirected.headers.get("X-Api-Key") == b"k", "clone should still carry it pre-fix"

  middleware.process_request(redirected, spider)
  assert redirected.headers.get("X-Api-Key") is None


def test_registered_middleware_path_is_loadable():
  from scrapy.utils.misc import load_object

  settings = build_spider_settings(make_crawl_request())
  for path in settings["DOWNLOADER_MIDDLEWARES"]:
    load_object(path)


def test_all_configured_headers_are_attached():
  middleware = AuthHeaderMiddleware()
  request = make_request("https://docs.example.com/")
  middleware.process_request(
    request,
    make_spider(headers={"Authorization": "Bearer a", "X-Api-Key": "b"}),
  )
  assert request.headers == {"Authorization": "Bearer a", "X-Api-Key": "b"}


# ============================================================================
# Worker wiring
# ============================================================================


def make_crawl_request(**overrides) -> CrawlRequest:
  defaults = dict(
    job_id="job-1",
    url="https://docs.example.com/",
    datasource_id="ds-1",
    crawl_mode=CrawlMode.SINGLE_URL.value,
  )
  defaults.update(overrides)
  return CrawlRequest(**defaults)


def test_middleware_runs_before_the_redirect_middleware():
  settings = build_spider_settings(make_crawl_request())
  middlewares = settings["DOWNLOADER_MIDDLEWARES"]
  priority = middlewares["ingestors.webloader.loader.scrapy_worker.AuthHeaderMiddleware"]
  # RedirectMiddleware sits at 600; running earlier means redirect re-issues
  # pass back through this middleware.
  assert priority < 600


def test_resolved_headers_default_to_absent():
  request = make_crawl_request()
  assert request.resolved_auth_headers is None
  assert request.auth_credential_labels == []


def test_resolved_headers_survive_ipc_serialization():
  from ingestors.webloader.loader.worker_types import WorkerMessage

  request = make_crawl_request(
    resolved_auth_headers={"Authorization": "Bearer secret-value"},
    auth_credential_labels=["docs-token"],
  )
  restored = CrawlRequest(**WorkerMessage.crawl_request(request).payload)
  assert restored.resolved_auth_headers == {"Authorization": "Bearer secret-value"}
  assert restored.auth_credential_labels == ["docs-token"]


# ============================================================================
# Failure messages
# ============================================================================


def make_failing_spider(**attributes):
  from ingestors.webloader.loader.scrapy_worker import WorkerSpider

  spider = WorkerSpider.__new__(WorkerSpider)
  spider.start_url = "https://docs.example.com/"
  spider.crawl_mode = CrawlMode.SINGLE_URL.value
  spider.effective_domain = None
  spider.max_pages = 10
  spider.pages_failed = 0
  spider.pages_fetched_no_content = 0
  spider.auth_denied_statuses = {}
  spider.auth_credential_labels = []
  spider.errors = []
  spider.urls_found_in_sitemap = 0
  spider.urls_matched_in_sitemap = 0
  spider.urls_filtered_external = 0
  spider.urls_filtered_pattern = 0
  spider.urls_filtered_max_pages = 0
  spider.sitemap_urls_checked = []
  spider.robots_urls_checked = []
  for key, value in attributes.items():
    setattr(spider, key, value)
  return spider


def test_rejected_requests_name_the_credential():
  spider = make_failing_spider(
    pages_failed=3,
    auth_denied_statuses={404: 3},
    auth_credential_labels=["docs-token"],
  )
  message = spider._build_failure_message()
  assert "docs-token" in message
  assert "404" in message
  assert "expired" in message


def test_empty_pages_blame_the_credential_when_one_was_used():
  spider = make_failing_spider(
    pages_fetched_no_content=4,
    auth_credential_labels=["docs-token"],
  )
  message = spider._build_failure_message()
  assert "docs-token" in message
  # The unauthenticated advice would be actively misleading here.
  assert "reachable without" not in message


def test_empty_pages_suggest_authentication_when_none_was_used():
  spider = make_failing_spider(pages_fetched_no_content=4)
  message = spider._build_failure_message()
  assert "reachable without" in message


def test_failure_message_never_contains_the_credential_value():
  spider = make_failing_spider(
    pages_failed=2,
    auth_denied_statuses={401: 2},
    auth_credential_labels=["docs-token"],
  )
  assert "Bearer" not in spider._build_failure_message()


def test_denied_statuses_are_ignored_without_a_credential():
  spider = make_failing_spider(pages_failed=2, auth_denied_statuses={404: 2})
  message = spider._build_failure_message()
  assert "credential" not in message.lower()
