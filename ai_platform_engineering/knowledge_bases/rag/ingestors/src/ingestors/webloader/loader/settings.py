"""
Scrapy settings builder for configuring crawl behavior.

Builds Scrapy settings dict from ScrapySettings model.
"""

from typing import Dict, Any

from common.models.server import ScrapySettings


# Default user agent mimicking Chrome browser
DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def build_scrapy_settings(settings: ScrapySettings) -> Dict[str, Any]:
  """
  Build Scrapy settings dictionary from ScrapySettings model.

  Args:
      settings: User-provided scraping settings

  Returns:
      Dictionary of Scrapy settings
  """
  scrapy_settings: Dict[str, Any] = {
    # NOTE: We don't set TWISTED_REACTOR here because the asyncio reactor
    # is installed manually in ingestor.py before the event loop starts.
    # Setting it here would cause Scrapy to try to install it again and fail.
    # Rate limiting
    "DOWNLOAD_DELAY": settings.download_delay,
    "CONCURRENT_REQUESTS": settings.concurrent_requests,
    "CONCURRENT_REQUESTS_PER_DOMAIN": min(settings.concurrent_requests, 16),
    "RANDOMIZE_DOWNLOAD_DELAY": True,
    # Respect robots.txt
    "ROBOTSTXT_OBEY": settings.respect_robots_txt,
    # Depth and page limits
    "DEPTH_LIMIT": settings.max_depth,
    "CLOSESPIDER_PAGECOUNT": settings.max_pages,
    # User agent
    "USER_AGENT": settings.user_agent or DEFAULT_USER_AGENT,
    # Auto-throttle for polite crawling
    "AUTOTHROTTLE_ENABLED": True,
    "AUTOTHROTTLE_START_DELAY": settings.download_delay,
    "AUTOTHROTTLE_MAX_DELAY": 10.0,
    "AUTOTHROTTLE_TARGET_CONCURRENCY": float(settings.concurrent_requests),
    # Retry settings - only retry on specific HTTP errors, not connection/timeout failures
    "RETRY_ENABLED": True,
    "RETRY_TIMES": 2,
    "RETRY_HTTP_CODES": [429, 500, 502, 503, 504],
    # Don't retry on connection/timeout errors - fail fast
    # Default includes TimeoutError, ConnectionRefusedError, etc. which we want to skip
    "RETRY_EXCEPTIONS": [],
    # Timeout settings
    "DOWNLOAD_TIMEOUT": settings.page_load_timeout,
    # DNS timeout (helps with unreachable hosts)
    "DNS_TIMEOUT": 5,
    # Use the threaded resolver because Twisted's async resolver has a
    # str/bytes mismatch for these requests.
    "DNS_RESOLVER": "scrapy.resolver.CachingThreadedResolver",
    # Disable cookies by default (for scraping)
    "COOKIES_ENABLED": False,
    # Logging
    "LOG_LEVEL": "INFO",
    # Disable telnet console (logs password on startup)
    "TELNETCONSOLE_ENABLED": False,
    # Don't filter duplicate requests (we handle this ourselves)
    "DUPEFILTER_DEBUG": True,
    # Memory management
    "MEMUSAGE_ENABLED": True,
    "MEMUSAGE_LIMIT_MB": 1024,
    "MEMUSAGE_WARNING_MB": 512,
  }

  # Add Playwright settings if JS rendering is enabled
  if settings.render_javascript:
    scrapy_settings.update(
      {
        "DOWNLOAD_HANDLERS": {
          "http": "scrapy_playwright.handler.ScrapyPlaywrightDownloadHandler",
          "https": "scrapy_playwright.handler.ScrapyPlaywrightDownloadHandler",
        },
        "PLAYWRIGHT_BROWSER_TYPE": "chromium",
        "PLAYWRIGHT_LAUNCH_OPTIONS": {
          "headless": True,
        },
        "PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT": settings.page_load_timeout * 1000,
        "PLAYWRIGHT_CONTEXTS": {
          "default": {
            "ignore_https_errors": True,
          }
        },
      }
    )

  return scrapy_settings


def get_playwright_page_methods(settings: ScrapySettings) -> list:
  """
  Build list of Playwright PageMethod calls based on settings.

  Args:
      settings: User-provided scraping settings

  Returns:
      List of PageMethod objects to execute on each page
  """
  from scrapy_playwright.page import PageMethod

  page_methods = []

  # Wait for specific selector if configured
  if settings.wait_for_selector:
    page_methods.append(PageMethod("wait_for_selector", settings.wait_for_selector, timeout=settings.page_load_timeout * 1000))

  # Wait for network idle to ensure dynamic content is loaded
  page_methods.append(PageMethod("wait_for_load_state", "networkidle", timeout=settings.page_load_timeout * 1000))

  return page_methods
