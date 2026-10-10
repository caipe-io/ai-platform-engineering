"""
Simple tests for the web content parsers.

These tests use mock Scrapy Response objects to verify that parsers
correctly detect and extract content from different documentation sites.
"""

from scrapy.http import HtmlResponse


# ============================================================================
# Test Fixtures - Sample HTML for different documentation frameworks
# ============================================================================


def make_response(html: str, url: str = "http://example.com/docs/page") -> HtmlResponse:
  """Create a mock HtmlResponse from HTML string."""
  return HtmlResponse(url=url, body=html.encode("utf-8"))


# Sample Docusaurus HTML
DOCUSAURUS_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta name="generator" content="Docusaurus v2.4.1">
    <meta name="description" content="This is a Docusaurus page">
    <title>Getting Started | My Docs</title>
</head>
<body>
    <nav class="navbar">Navigation here</nav>
    <article>
        <h1>Getting Started</h1>
        <p>Welcome to the documentation.</p>
        <p>This is the main content of the page.</p>
    </article>
    <footer>Footer content</footer>
</body>
</html>
"""

# Sample MkDocs HTML
MKDOCS_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta name="generator" content="mkdocs-1.5.3, mkdocs-material-9.4.0">
    <meta name="description" content="MkDocs documentation">
    <title>Welcome - My MkDocs Site</title>
</head>
<body>
    <nav class="md-nav">Navigation</nav>
    <main class="md-main">
        <div class="md-content">
            <article class="md-content__inner">
                <h1>Welcome</h1>
                <p>This is MkDocs content.</p>
                <p>More documentation text here.</p>
            </article>
        </div>
    </main>
</body>
</html>
"""

# Sample generic HTML (no specific framework)
GENERIC_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta name="description" content="A generic website">
    <title>Welcome Page</title>
</head>
<body>
    <header>Site Header</header>
    <nav>Navigation links</nav>
    <main>
        <h1>Welcome</h1>
        <p>This is the main content.</p>
        <p>More text content here.</p>
    </main>
    <footer>Site Footer</footer>
</body>
</html>
"""

# Sample Sphinx HTML
SPHINX_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta name="generator" content="Sphinx 7.2.6">
    <meta name="description" content="Sphinx documentation">
    <title>Introduction — My Project documentation</title>
</head>
<body>
    <div class="sphinxsidebar">Sidebar content</div>
    <div class="document">
        <div class="body" role="main">
            <section>
                <h1>Introduction</h1>
                <p>This is Sphinx documentation content.</p>
            </section>
        </div>
    </div>
</body>
</html>
"""


# ============================================================================
# Parser Detection Tests
# ============================================================================


class TestParserDetection:
  """Tests for parser can_parse() detection logic."""

  def test_docusaurus_detected_by_generator(self):
    """Docusaurus parser should detect pages with Docusaurus generator meta tag."""
    from ingestors.webloader.loader.parsers.docusaurus import DocusaurusParser

    response = make_response(DOCUSAURUS_HTML)
    assert DocusaurusParser.can_parse(response) is True

  def test_mkdocs_detected_by_generator(self):
    """MkDocs parser should detect pages with mkdocs generator meta tag."""
    from ingestors.webloader.loader.parsers.mkdocs import MkDocsParser

    response = make_response(MKDOCS_HTML)
    assert MkDocsParser.can_parse(response) is True

  def test_sphinx_detected_by_generator(self):
    """Sphinx parser should detect pages with Sphinx generator meta tag."""
    from ingestors.webloader.loader.parsers.sphinx import SphinxParser

    response = make_response(SPHINX_HTML)
    assert SphinxParser.can_parse(response) is True

  def test_generic_always_matches(self):
    """Generic parser should always return True (it's the fallback)."""
    from ingestors.webloader.loader.parsers.generic import GenericParser

    response = make_response(GENERIC_HTML)
    assert GenericParser.can_parse(response) is True


# ============================================================================
# Content Extraction Tests
# ============================================================================


class TestContentExtraction:
  """Tests for parser extract() content extraction."""

  def test_docusaurus_extracts_article_content(self):
    """Docusaurus parser should extract content from article tag."""
    from ingestors.webloader.loader.parsers.docusaurus import DocusaurusParser

    response = make_response(DOCUSAURUS_HTML)
    result = DocusaurusParser.extract(response)

    assert result.title == "Getting Started | My Docs"
    assert result.description == "This is a Docusaurus page"
    assert "Welcome to the documentation" in result.content
    assert "main content" in result.content
    # Should not include navigation
    assert "Navigation here" not in result.content

  def test_mkdocs_extracts_md_content(self):
    """MkDocs parser should extract content from md-content class."""
    from ingestors.webloader.loader.parsers.mkdocs import MkDocsParser

    response = make_response(MKDOCS_HTML)
    result = MkDocsParser.extract(response)

    assert result.title == "Welcome - My MkDocs Site"
    assert "MkDocs content" in result.content
    # Should not include navigation
    assert "Navigation" not in result.content or result.content.count("Navigation") == 0

  def test_generic_extracts_main_content(self):
    """Generic parser should extract content from main tag."""
    from ingestors.webloader.loader.parsers.generic import GenericParser

    response = make_response(GENERIC_HTML)
    result = GenericParser.extract(response)

    assert result.title == "Welcome Page"
    assert result.description == "A generic website"
    assert "main content" in result.content

  def test_sphinx_extracts_body_content(self):
    """Sphinx parser should extract content from document body."""
    from ingestors.webloader.loader.parsers.sphinx import SphinxParser

    response = make_response(SPHINX_HTML)
    result = SphinxParser.extract(response)

    assert "Introduction" in result.title or "Introduction" in result.content
    assert "Sphinx documentation content" in result.content


# ============================================================================
# Metadata Extraction Tests
# ============================================================================


class TestMetadataExtraction:
  """Tests for metadata extraction (title, description, language)."""

  def test_extracts_language(self):
    """Parsers should extract the html lang attribute."""
    from ingestors.webloader.loader.parsers.generic import GenericParser

    response = make_response(GENERIC_HTML)
    result = GenericParser.extract(response)

    assert result.language == "en"

  def test_extracts_generator(self):
    """Parsers should extract the generator meta tag."""
    from ingestors.webloader.loader.parsers.docusaurus import DocusaurusParser

    response = make_response(DOCUSAURUS_HTML)
    result = DocusaurusParser.extract(response)

    assert result.generator is not None
    assert "Docusaurus" in result.generator

  def test_missing_description_returns_empty(self):
    """Missing description meta tag should return empty string."""
    from ingestors.webloader.loader.parsers.generic import GenericParser

    html = """
        <!DOCTYPE html>
        <html><head><title>No Description</title></head>
        <body><main><p>Content</p></main></body></html>
        """
    response = make_response(html)
    result = GenericParser.extract(response)

    assert result.description == ""


# ============================================================================
# Registry Tests
# ============================================================================


class TestParserRegistry:
  """Tests for the parser registry automatic selection."""

  def test_registry_selects_docusaurus_for_docusaurus_page(self):
    """Registry should select DocusaurusParser for Docusaurus pages."""
    from ingestors.webloader.loader.parsers.registry import ParserRegistry
    from ingestors.webloader.loader.parsers.docusaurus import DocusaurusParser

    response = make_response(DOCUSAURUS_HTML)
    parser = ParserRegistry.get_parser(response)

    assert parser == DocusaurusParser

  def test_registry_selects_generic_for_unknown_pages(self):
    """Registry should fall back to GenericParser for unknown pages."""
    from ingestors.webloader.loader.parsers.registry import ParserRegistry
    from ingestors.webloader.loader.parsers.generic import GenericParser

    response = make_response(GENERIC_HTML)
    parser = ParserRegistry.get_parser(response)

    assert parser == GenericParser

  def test_registry_parse_returns_result(self):
    """Registry.parse() should return a ParseResult."""
    from ingestors.webloader.loader.parsers.registry import ParserRegistry
    from ingestors.webloader.loader.parsers.base import ParseResult

    response = make_response(GENERIC_HTML)
    result = ParserRegistry.parse(response)

    assert isinstance(result, ParseResult)
    assert result.title == "Welcome Page"


# ============================================================================
# ReadTheDocs URL hostname validation
# ============================================================================

RTD_HTML = """
<!DOCTYPE html>
<html>
<body>
<div class="wy-body-for-nav">
  <div class="wy-nav-content-wrap">
    <div class="rst-content">
      <h1>ReadTheDocs Page</h1>
      <p>Content here.</p>
    </div>
  </div>
</div>
</body>
</html>
"""


class TestReadTheDocsHostnameValidation:

  def test_readthedocs_io_detected(self):
    from ingestors.webloader.loader.parsers.readthedocs import ReadTheDocsParser
    response = make_response(RTD_HTML, url="https://docs.readthedocs.io/en/stable/")
    assert ReadTheDocsParser.can_parse(response) is True

  def test_readthedocs_org_detected(self):
    from ingestors.webloader.loader.parsers.readthedocs import ReadTheDocsParser
    response = make_response(RTD_HTML, url="https://myproject.readthedocs.org/en/latest/")
    assert ReadTheDocsParser.can_parse(response) is True

  def test_non_readthedocs_domain_not_detected_by_url(self):
    from ingestors.webloader.loader.parsers.readthedocs import ReadTheDocsParser
    # Domain contains "readthedocs" only as a substring path — should not match via URL
    response = make_response("<html><body><p>plain</p></body></html>",
                             url="https://example.com/path/readthedocs.io/page")
    assert ReadTheDocsParser.can_parse(response) is False

  def test_evil_lookalike_domain_rejected(self):
    from ingestors.webloader.loader.parsers.readthedocs import ReadTheDocsParser
    # evil-readthedocs.io should NOT match even though it contains the substring
    response = make_response("<html><body><p>plain</p></body></html>",
                             url="https://evil-readthedocs.io/page")
    assert ReadTheDocsParser.can_parse(response) is False
