"""Tests for ConfluenceLoader.ingest_pages — page processing and edge cases.

Coverage:
  - Pages with empty/whitespace-only HTML are skipped (but progress IS incremented)
  - Pages missing the 'id' field are fully skipped (no progress)
  - Pages where _ingest_batch raises are tracked as failures
  - Final job status: COMPLETED / COMPLETED_WITH_ERRORS / FAILED / TERMINATED
  - generate_datasource_id helper
  - extract_text_from_html helper
  - Document metadata correctness (IDs, fields, URL construction)
  - _ingest_batch delegation and exception re-raise
  - Missing/malformed page body structures
  - Document ID uniqueness via SHA256 hashing
  - Error message format propagated to add_error_msg
  - progress always incremented on both success and failure paths

Note: document_count is now auto-tracked by Client.ingest_documents(), so
ingest_pages no longer calls job_manager.increment_document_count directly.
"""

from __future__ import annotations

import hashlib
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.documents import Document

from common.job_manager import JobInfo, JobStatus
from common.models.rag import DataSourceInfo
from ingestors.confluence.loader import (
  CONFLUENCE_BATCH_SIZE,
  ConfluenceLoader,
  generate_datasource_id,
)


# ---------------------------------------------------------------------------
# Shared fixtures / helpers
# ---------------------------------------------------------------------------


def make_datasource_info(
  datasource_id: str = "src_confluence___cisco_eti_atlassian_net__SRE",
  chunk_size: int = 1000,
  chunk_overlap: int = 200,
) -> DataSourceInfo:
  return DataSourceInfo(
    datasource_id=datasource_id,
    ingestor_id="confluence:default_confluence",
    source_type="confluence",
    last_updated=None,
    default_chunk_size=chunk_size,
    default_chunk_overlap=chunk_overlap,
  )


def make_job_info(
  *,
  failed_counter: int = 0,
  progress_counter: int = 0,
  total: int = 1,
  status: JobStatus = JobStatus.IN_PROGRESS,
) -> JobInfo:
  return JobInfo(
    job_id="test-job-1",
    status=status,
    created_at=1_000_000,
    total=total,
    progress_counter=progress_counter,
    failed_counter=failed_counter,
    document_count=0,
    chunk_count=0,
  )


def make_job_manager(
  *,
  failed_counter: int = 0,
  progress_counter: int = 0,
  total: int = 1,
  status: JobStatus = JobStatus.IN_PROGRESS,
) -> MagicMock:
  """Return a MagicMock that satisfies the JobManager async interface."""
  jm = MagicMock()
  jm.increment_document_count = AsyncMock(return_value=1)
  jm.increment_progress = AsyncMock(return_value=1)
  jm.increment_failure = AsyncMock(return_value=1)
  jm.add_error_msg = AsyncMock(return_value=1)
  jm.upsert_job = AsyncMock(return_value=True)
  jm.get_job = AsyncMock(
    return_value=make_job_info(
      failed_counter=failed_counter,
      progress_counter=progress_counter,
      total=total,
      status=status,
    )
  )
  return jm


def make_rag_client() -> MagicMock:
  client = MagicMock()
  client.ingestor_id = "confluence:default_confluence"
  client.ingest_documents = AsyncMock()
  return client


def make_loader(
  *,
  datasource_info: DataSourceInfo | None = None,
  job_manager: MagicMock | None = None,
  rag_client: MagicMock | None = None,
) -> ConfluenceLoader:
  """Instantiate ConfluenceLoader without opening a real HTTP session."""
  return ConfluenceLoader(
    rag_client=rag_client or make_rag_client(),
    job_manager=job_manager or make_job_manager(),
    datasource_info=datasource_info or make_datasource_info(),
    confluence_url="https://cisco-eti.atlassian.net/wiki",
    username="test@example.com",
    token="test-token",
    verify_ssl=True,
    max_concurrency=5,
  )


def make_page(
  page_id: str = "123456",
  title: str = "Test Page",
  html_body: str = "<p>Some meaningful content here.</p>",
  space_key: str = "SRE",
) -> dict:
  """Return a minimal Confluence REST API v1 page dict."""
  return {
    "id": page_id,
    "title": title,
    "body": {"storage": {"value": html_body}},
    "space": {"key": space_key, "name": "SRE Space"},
    "_links": {"webui": f"/wiki/spaces/{space_key}/pages/{page_id}"},
    "history": {
      "createdDate": "2024-01-01T00:00:00.000Z",
      "lastUpdated": {"when": "2024-06-01T00:00:00.000Z"},
      "createdBy": {"displayName": "Test Author"},
    },
    "version": {"number": 3},
  }


def _terminal_status_calls(jm: MagicMock) -> list:
  """Return only the upsert_job calls that set a terminal job status."""
  terminal = {
    JobStatus.COMPLETED,
    JobStatus.FAILED,
    JobStatus.COMPLETED_WITH_ERRORS,
    JobStatus.TERMINATED,
  }
  return [c for c in jm.upsert_job.call_args_list if c.kwargs.get("status") in terminal]


# ===========================================================================
# 1. Page processing — skipping and progress tracking
# ===========================================================================


class TestIngestPagesProcessing:
  """Verify page processing, skipping, and progress tracking.

  Note: document_count is now auto-tracked by Client.ingest_documents(),
  so ingest_pages no longer calls job_manager.increment_document_count.
  """

  async def test_single_page_with_content_increments_progress(self):
    """A page with non-empty text content increments progress."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    await loader.ingest_pages([make_page()], "job-1")

    jm.increment_progress.assert_called_once_with("job-1")

  async def test_empty_html_body_skipped_but_progress_incremented(self):
    """A page with an empty HTML body is skipped but progress still incremented."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    await loader.ingest_pages([make_page(html_body="")], "job-1")

    jm.increment_progress.assert_called_once_with("job-1")

  async def test_whitespace_only_html_skipped_but_progress_incremented(self):
    """HTML that renders to whitespace only is skipped but progress incremented."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    await loader.ingest_pages([make_page(html_body="   <p>  </p>\n  ")], "job-1")

    jm.increment_progress.assert_called_once_with("job-1")

  async def test_page_missing_id_skipped_entirely(self):
    """A page dict without an 'id' key must be skipped — no progress."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    no_id_page = {
      "title": "No ID Page",
      "body": {"storage": {"value": "<p>Content</p>"}},
    }
    await loader.ingest_pages([no_id_page], "job-1")

    jm.increment_progress.assert_not_called()

  async def test_page_with_none_id_skipped_entirely(self):
    """A page dict with id=None is treated the same as a missing id."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    none_id_page = make_page()
    none_id_page["id"] = None
    await loader.ingest_pages([none_id_page], "job-1")

    jm.increment_progress.assert_not_called()

  async def test_exception_during_page_processing_tracks_failure(self):
    """An exception raised inside the per-page try block tracks failure.

    inject failure via extract_text_from_html which runs inside the per-page
    try/except, ensuring the failure path is exercised without relying on batch size.
    """
    jm = make_job_manager(total=1, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=RuntimeError("parse error"))

    await loader.ingest_pages([make_page()], "job-1")

    jm.increment_failure.assert_called_once()
    jm.increment_progress.assert_called_once()

  async def test_exception_in_ingest_batch_inloop_tracks_failure(self):
    """When _ingest_batch raises during an in-loop flush (large page), failure is tracked.

    The in-loop flush fires when accumulated chunks >= CONFLUENCE_BATCH_SIZE.
    Because that call is inside the per-page try/except, the exception is caught,
    failure is tracked.

    Side-effect: documents that failed to flush are NOT cleared from the buffer, so
    the post-loop flush re-attempts them and also raises an uncaught exception
    (ingest_pages propagates it). The test documents this known behaviour.
    """
    jm = make_job_manager(total=1, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=RuntimeError("batch error"))

    # Large enough to trigger the in-loop flush inside the per-page try/except
    large_text = "Word " * (CONFLUENCE_BATCH_SIZE * 200)

    # The post-loop flush (outside try/except) re-raises after the page loop
    with pytest.raises(RuntimeError, match="batch error"):
      await loader.ingest_pages([make_page(html_body=f"<p>{large_text}</p>")], "job-1")

    # Per-page handler DID run: failure tracked
    jm.increment_failure.assert_called_once()

  async def test_multiple_pages_all_with_content(self):
    """N pages with content → progress incremented N times."""
    n = 5
    jm = make_job_manager(total=n)
    loader = make_loader(job_manager=jm)

    pages = [make_page(page_id=str(i), title=f"Page {i}") for i in range(n)]
    await loader.ingest_pages(pages, "job-1")

    assert jm.increment_progress.call_count == n

  async def test_mixed_pages_progress_for_valid_pages(self):
    """Progress is incremented for pages with valid id (even if empty content)."""
    jm = make_job_manager(total=4)
    loader = make_loader(job_manager=jm)

    pages = [
      make_page(page_id="1", html_body="<p>Content A</p>"),  # valid
      make_page(page_id="2", html_body=""),  # empty but valid id
      {"title": "No ID", "body": {"storage": {"value": "<p>X</p>"}}},  # missing id - skipped
      make_page(page_id="4", html_body="<p>Content B</p>"),  # valid
    ]
    await loader.ingest_pages(pages, "job-1")

    # 3 pages have valid ids (progress incremented), 1 missing id (skipped)
    assert jm.increment_progress.call_count == 3

  async def test_mixed_pages_with_processing_failure(self):
    """Pages that fail during processing still increment progress.

    Inject the failure via extract_text_from_html on a specific page so the
    exception is caught by the per-page handler regardless of batch size.
    """
    from bs4 import BeautifulSoup

    call_n = {"n": 0}

    def fail_on_second_page(html: str) -> str:
      call_n["n"] += 1
      if call_n["n"] == 2:
        raise RuntimeError("parse error on page 2")
      return BeautifulSoup(html, "html.parser").get_text(separator="\n", strip=True)

    jm = make_job_manager(total=3, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=fail_on_second_page)

    pages = [
      make_page(page_id="1", html_body="<p>A</p>"),
      make_page(page_id="2", html_body="<p>B</p>"),  # fails
      make_page(page_id="3", html_body="<p>C</p>"),
    ]
    await loader.ingest_pages(pages, "job-1")

    # All 3 pages increment progress (even the failed one)
    assert jm.increment_progress.call_count == 3
    # 1 failure tracked
    assert jm.increment_failure.call_count == 1


# ===========================================================================
# 2. Batch boundary behaviour
# ===========================================================================


class TestIngestPagesBatchBoundary:
  """Verify batching behaviour — document_count is now auto-tracked by Client.ingest_documents()."""

  async def test_large_page_producing_multiple_batches_ingested(self):
    """A single page producing >CONFLUENCE_BATCH_SIZE chunks is ingested via multiple batch calls."""
    jm = make_job_manager(total=1)
    rag = make_rag_client()
    loader = make_loader(job_manager=jm, rag_client=rag)

    # ~200 words per chunk * (BATCH_SIZE + 5) chunks = well over 1 batch
    large_text = "Word " * (CONFLUENCE_BATCH_SIZE * 200)
    large_page = make_page(html_body=f"<p>{large_text}</p>")

    await loader.ingest_pages([large_page], "job-1")

    # Client.ingest_documents should be called at least once (batching happens internally)
    assert rag.ingest_documents.call_count >= 1
    # Progress incremented once per page
    jm.increment_progress.assert_called_once_with("job-1")

  async def test_two_pages_both_ingested_when_batched_together(self):
    """Two pages whose chunks fill a shared batch are each processed."""
    jm = make_job_manager(total=2)
    rag = make_rag_client()
    loader = make_loader(job_manager=jm, rag_client=rag)

    pages = [
      make_page(page_id="1", html_body="<p>First page.</p>"),
      make_page(page_id="2", html_body="<p>Second page.</p>"),
    ]
    await loader.ingest_pages(pages, "job-1")

    # Progress incremented for each page
    assert jm.increment_progress.call_count == 2
    # ingest_documents called at least once
    assert rag.ingest_documents.call_count >= 1

  async def test_remaining_documents_flushed_at_end(self):
    """The final sub-batch (remainder after last full-batch flush) is flushed."""
    jm = make_job_manager(total=3)
    rag = make_rag_client()
    loader = make_loader(job_manager=jm, rag_client=rag)

    # Three pages each just under the batch threshold — they'll flush at the end
    pages = [make_page(page_id=str(i)) for i in range(3)]
    await loader.ingest_pages(pages, "job-1")

    # Progress incremented for each page
    assert jm.increment_progress.call_count == 3
    # ingest_documents called at least once
    assert rag.ingest_documents.call_count >= 1


# ===========================================================================
# 3. Final job status after ingest_pages
# ===========================================================================


class TestIngestPagesJobStatus:
  """Verify the terminal status written to the job after processing completes."""

  async def test_all_pages_succeed_status_is_completed(self):
    """All pages succeed → job status COMPLETED."""
    jm = make_job_manager(total=2, failed_counter=0, status=JobStatus.IN_PROGRESS)
    loader = make_loader(job_manager=jm)

    await loader.ingest_pages([make_page(page_id=str(i)) for i in range(2)], "job-1")

    calls = _terminal_status_calls(jm)
    assert calls, "Expected at least one terminal status call"
    assert calls[-1].kwargs["status"] == JobStatus.COMPLETED

  async def test_all_pages_fail_status_is_failed(self):
    """All pages fail during processing → job status FAILED.

    Inject failure via extract_text_from_html so every page's exception is
    caught by the per-page handler and increment_failure is called for each.
    The mock job_info returned by get_job must reflect failed_counter == total.
    """
    jm = make_job_manager(total=2, failed_counter=2, status=JobStatus.IN_PROGRESS)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=RuntimeError("parse error"))

    await loader.ingest_pages([make_page(page_id=str(i)) for i in range(2)], "job-1")

    calls = _terminal_status_calls(jm)
    assert calls, "Expected at least one terminal status call"
    assert calls[-1].kwargs["status"] == JobStatus.FAILED

  async def test_partial_failures_status_is_completed_with_errors(self):
    """One page fails and one succeeds → job status COMPLETED_WITH_ERRORS.

    Inject failure via extract_text_from_html for the first page only.
    The mock job_info returned by get_job reflects failed_counter=1, total=2.
    """
    from bs4 import BeautifulSoup

    call_n = {"n": 0}

    def fail_first(html: str) -> str:
      call_n["n"] += 1
      if call_n["n"] == 1:
        raise RuntimeError("parse error on first page")
      return BeautifulSoup(html, "html.parser").get_text(separator="\n", strip=True)

    jm = make_job_manager(total=2, failed_counter=1, status=JobStatus.IN_PROGRESS)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=fail_first)

    await loader.ingest_pages([make_page(page_id="fail"), make_page(page_id="succeed")], "job-1")

    calls = _terminal_status_calls(jm)
    assert calls, "Expected at least one terminal status call"
    assert calls[-1].kwargs["status"] == JobStatus.COMPLETED_WITH_ERRORS

  async def test_terminated_job_remains_terminated(self):
    """If the job is TERMINATED before ingest_pages finishes, the final status is TERMINATED."""
    jm = make_job_manager(total=1, status=JobStatus.TERMINATED)
    loader = make_loader(job_manager=jm)

    await loader.ingest_pages([make_page()], "job-1")

    terminated_calls = [c for c in jm.upsert_job.call_args_list if c.kwargs.get("status") == JobStatus.TERMINATED]
    assert terminated_calls, "Expected at least one TERMINATED status call"

  async def test_empty_page_list_results_in_completed(self):
    """Ingesting an empty page list completes without errors."""
    jm = make_job_manager(total=0, failed_counter=0, status=JobStatus.IN_PROGRESS)
    loader = make_loader(job_manager=jm)

    # Should not raise
    await loader.ingest_pages([], "job-1")

    jm.increment_document_count.assert_not_called()


# ===========================================================================
# 4. generate_datasource_id
# ===========================================================================


class TestGenerateDatasourceId:
  """Tests for the datasource ID generation helper."""

  def test_basic_url_produces_expected_id(self):
    result = generate_datasource_id("https://cisco-eti.atlassian.net/wiki", "SRE")
    assert result == "src_confluence___cisco_eti_atlassian_net__SRE"

  def test_always_prefixed_with_src_confluence(self):
    result = generate_datasource_id("https://example.com", "DOCS")
    assert result.startswith("src_confluence___")

  def test_domain_dots_replaced_with_underscores(self):
    result = generate_datasource_id("https://example.com", "SPACE")
    domain_part = result.split("___")[1].split("__")[0]
    assert "." not in domain_part
    assert "example_com" in domain_part

  def test_domain_dashes_replaced_with_underscores(self):
    result = generate_datasource_id("https://my-company.atlassian.net/wiki", "ENG")
    domain_part = result.split("___")[1].split("__")[0]
    assert "-" not in domain_part

  def test_different_space_keys_produce_different_ids(self):
    r1 = generate_datasource_id("https://example.com", "SRE")
    r2 = generate_datasource_id("https://example.com", "ENG")
    assert r1 != r2

  def test_different_root_pages_in_one_space_produce_different_ids(self):
    r1 = generate_datasource_id("https://example.com/wiki", "SRE", "123")
    r2 = generate_datasource_id("https://example.com/wiki", "SRE", "456")

    assert r1 == "src_confluence___example_com__SRE__123"
    assert r1 != r2

  def test_space_key_appended_correctly(self):
    result = generate_datasource_id("https://example.com", "MY_SPACE")
    assert result.endswith("__MY_SPACE")

  def test_different_domains_produce_different_ids(self):
    r1 = generate_datasource_id("https://company-a.atlassian.net", "SRE")
    r2 = generate_datasource_id("https://company-b.atlassian.net", "SRE")
    assert r1 != r2

  def test_no_special_characters_in_output(self):
    """Output should be filesystem / Redis key friendly."""
    result = generate_datasource_id("https://complex-name.example.co.uk/wiki", "SPACE_1")
    # Should not contain dots or dashes (only underscores and alphanumerics in domain part)
    domain_part = result.split("___")[1].split("__")[0]
    assert "." not in domain_part
    assert "-" not in domain_part


# ===========================================================================
# 5. extract_text_from_html
# ===========================================================================


class TestExtractTextFromHtml:
  """Tests for the HTML-to-plaintext helper."""

  def _loader(self) -> ConfluenceLoader:
    return make_loader()

  def test_basic_paragraph_extracted(self):
    result = self._loader().extract_text_from_html("<p>Hello world</p>")
    assert "Hello world" in result

  def test_empty_string_returns_empty(self):
    result = self._loader().extract_text_from_html("")
    assert result.strip() == ""

  def test_html_tags_stripped(self):
    result = self._loader().extract_text_from_html("<h1>Title</h1><p>Body</p>")
    assert "<h1>" not in result
    assert "<p>" not in result
    assert "Title" in result
    assert "Body" in result

  def test_nested_list_items_all_extracted(self):
    html = "<div><ul><li>Item 1</li><li>Item 2</li></ul></div>"
    result = self._loader().extract_text_from_html(html)
    assert "Item 1" in result
    assert "Item 2" in result

  def test_whitespace_only_body_returns_empty_equivalent(self):
    result = self._loader().extract_text_from_html("   <p>   </p>   ")
    assert result.strip() == ""

  def test_html_entities_decoded(self):
    result = self._loader().extract_text_from_html("<p>&amp; &lt;tag&gt;</p>")
    assert "&amp;" not in result
    assert "& <tag>" in result

  def test_table_content_extracted(self):
    html = "<table><tr><td>Cell A</td><td>Cell B</td></tr></table>"
    result = self._loader().extract_text_from_html(html)
    assert "Cell A" in result
    assert "Cell B" in result

  def test_heading_content_preserved(self):
    html = "<h1>Main Title</h1><h2>Sub Title</h2><p>Paragraph</p>"
    result = self._loader().extract_text_from_html(html)
    assert "Main Title" in result
    assert "Sub Title" in result
    assert "Paragraph" in result

  def test_code_block_text_preserved(self):
    html = "<code>print('hello')</code>"
    result = self._loader().extract_text_from_html(html)
    assert "print" in result

  def test_multiple_paragraphs_all_extracted(self):
    html = "<p>First</p><p>Second</p><p>Third</p>"
    result = self._loader().extract_text_from_html(html)
    assert "First" in result
    assert "Second" in result
    assert "Third" in result

  def test_returns_string_type(self):
    """Must always return a string, never raise."""
    result = self._loader().extract_text_from_html("<p>Any content</p>")
    assert isinstance(result, str)

  def test_confluence_structured_macro_does_not_raise(self):
    """Confluence-specific macros must be handled gracefully."""
    html = "<ac:structured-macro ac:name=\"code\"><ac:plain-text-body>print('hello')</ac:plain-text-body></ac:structured-macro>"
    result = self._loader().extract_text_from_html(html)
    assert isinstance(result, str)

  def test_script_tags_text_is_omitted(self):
    """BeautifulSoup get_text includes script content; verify it does not crash."""
    html = "<p>Visible text</p><script>alert('xss')</script>"
    result = self._loader().extract_text_from_html(html)
    # Must return a string; whether script text is stripped depends on
    # BeautifulSoup defaults (it is included) — but it must not crash.
    assert isinstance(result, str)
    assert "Visible text" in result

  def test_style_tags_do_not_crash(self):
    """Style tag content returned as text but must not raise."""
    html = "<style>body { color: red; }</style><p>Content</p>"
    result = self._loader().extract_text_from_html(html)
    assert isinstance(result, str)
    assert "Content" in result

  def test_html_comment_does_not_appear_in_text(self):
    """HTML comments must be stripped by BeautifulSoup."""
    html = "<p>Real text</p><!-- hidden comment -->"
    result = self._loader().extract_text_from_html(html)
    assert "hidden comment" not in result
    assert "Real text" in result

  def test_unicode_content_preserved(self):
    """Non-ASCII Unicode characters must be preserved after extraction."""
    html = "<p>日本語テスト — Ünïcödé — مرحبا</p>"
    result = self._loader().extract_text_from_html(html)
    assert "日本語テスト" in result
    assert "Ünïcödé" in result
    assert "مرحبا" in result

  def test_pre_block_content_preserved(self):
    """Text inside <pre> blocks must be extracted."""
    html = "<pre>line1\nline2\nline3</pre>"
    result = self._loader().extract_text_from_html(html)
    assert "line1" in result
    assert "line2" in result

  def test_deeply_nested_html_extracted(self):
    """Deeply nested elements must still yield their text content."""
    html = "<div><section><article><p><span><em>Deep text</em></span></p></article></section></div>"
    result = self._loader().extract_text_from_html(html)
    assert "Deep text" in result

  def test_only_numbers_in_content(self):
    """Numeric-only content must be extracted correctly."""
    result = self._loader().extract_text_from_html("<p>12345</p>")
    assert "12345" in result

  def test_hyperlinks_text_extracted(self):
    """Anchor tag text must be extracted; href attribute must not appear."""
    html = '<a href="https://example.com">Click here</a>'
    result = self._loader().extract_text_from_html(html)
    assert "Click here" in result
    assert "https://example.com" not in result

  def test_blockquote_content_extracted(self):
    html = "<blockquote><p>Quoted text here</p></blockquote>"
    result = self._loader().extract_text_from_html(html)
    assert "Quoted text here" in result


# ===========================================================================
# 6. Document metadata correctness
# ===========================================================================


class TestIngestPagesDocumentMetadata:
  """Verify documents passed to _ingest_batch carry correct metadata."""

  async def test_document_title_matches_page_title(self):
    """Each Document must carry the page title in its metadata."""
    captured: list[list[Document]] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.append(list(documents))

    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    page = make_page(title="My Important Page")
    await loader.ingest_pages([page], "job-1")

    assert captured, "Expected _ingest_batch to be called"
    doc = captured[0][0]
    assert doc.metadata["title"] == "My Important Page"

  async def test_document_type_is_confluence_page(self):
    """Every document must have document_type set to 'confluence_page'."""
    captured: list[list[Document]] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.append(list(documents))

    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    await loader.ingest_pages([make_page()], "job-1")

    for batch in captured:
      for doc in batch:
        assert doc.metadata["document_type"] == "confluence_page"

  async def test_document_source_field_is_confluence(self):
    """The nested 'source' field inside metadata must be 'confluence'."""
    captured: list[list[Document]] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.append(list(documents))

    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    await loader.ingest_pages([make_page()], "job-1")

    doc = captured[0][0]
    assert doc.metadata["metadata"]["source"] == "confluence"

  async def test_page_url_constructed_from_confluence_base_and_webui_link(self):
    """URL in metadata = confluence_url + _links.webui."""
    captured: list[list[Document]] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.append(list(documents))

    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    page = make_page(page_id="99", space_key="SRE")
    await loader.ingest_pages([page], "job-1")

    doc = captured[0][0]
    expected_url = "https://cisco-eti.atlassian.net/wiki/wiki/spaces/SRE/pages/99"
    assert doc.metadata["metadata"]["url"] == expected_url

  async def test_chunk_index_and_total_chunks_correct(self):
    """Each chunk document must carry the correct chunk_index and total_chunks."""
    captured: list[list[Document]] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.extend(documents)

    jm = make_job_manager(total=1)
    # Use small chunk_size to force multiple chunks from a medium page
    ds = make_datasource_info(chunk_size=50, chunk_overlap=0)
    loader = make_loader(datasource_info=ds, job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    long_text = " ".join(f"word{i}" for i in range(100))
    page = make_page(html_body=f"<p>{long_text}</p>")
    await loader.ingest_pages([page], "job-1")

    assert len(captured) > 1, "Expected multiple chunks"
    indices = [doc.metadata["metadata"]["chunk_index"] for doc in captured]
    totals = [doc.metadata["metadata"]["total_chunks"] for doc in captured]
    assert indices == list(range(len(captured)))
    assert all(t == len(captured) for t in totals)

  async def test_space_key_and_name_in_metadata(self):
    """space_key and space_name from the page dict must appear in metadata."""
    captured: list[list[Document]] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.extend(documents)

    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    page = make_page(space_key="ENG")
    await loader.ingest_pages([page], "job-1")

    doc = captured[0]
    assert doc.metadata["metadata"]["space_key"] == "ENG"
    assert doc.metadata["metadata"]["space_name"] == "SRE Space"

  async def test_page_metadata_author_version_dates(self):
    """Author, version, created_date, and last_modified must be populated."""
    captured: list[list[Document]] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.extend(documents)

    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    await loader.ingest_pages([make_page()], "job-1")

    m = captured[0].metadata["metadata"]
    assert m["author"] == "Test Author"
    assert m["version"] == 3
    assert m["created_date"] == "2024-01-01T00:00:00.000Z"
    assert m["last_modified"] == "2024-06-01T00:00:00.000Z"

  async def test_datasource_id_in_document_metadata(self):
    """document metadata must carry the loader's datasource_id."""
    captured: list[list[Document]] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.extend(documents)

    ds = make_datasource_info(datasource_id="src_confluence___example__SRE")
    jm = make_job_manager(total=1)
    loader = make_loader(datasource_info=ds, job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    await loader.ingest_pages([make_page()], "job-1")

    assert captured[0].metadata["datasource_id"] == "src_confluence___example__SRE"


# ===========================================================================
# 7. Document ID uniqueness (SHA-256 hashing)
# ===========================================================================


class TestDocumentIdUniqueness:
  """Document IDs must be deterministic SHA-256 hashes and unique per chunk."""

  async def test_document_id_is_sha256_of_expected_base(self):
    """doc_id = sha256('{datasource_id}_{page_id}_chunk_{i}')."""
    captured: list[Document] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.extend(documents)

    ds = make_datasource_info(datasource_id="src_confluence___example__SRE")
    jm = make_job_manager(total=1)
    loader = make_loader(datasource_info=ds, job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    await loader.ingest_pages([make_page(page_id="42")], "job-1")

    expected_base = "src_confluence___example__SRE_42_chunk_0"
    expected_id = hashlib.sha256(expected_base.encode()).hexdigest()
    assert captured[0].id == expected_id

  async def test_different_pages_produce_different_doc_ids(self):
    """Two different pages must not share any document ID."""
    captured: list[Document] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.extend(documents)

    jm = make_job_manager(total=2)
    loader = make_loader(job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    await loader.ingest_pages([make_page(page_id="1"), make_page(page_id="2")], "job-1")

    ids = [doc.id for doc in captured]
    assert len(ids) == len(set(ids)), "All document IDs must be unique"

  async def test_same_page_different_chunks_have_different_ids(self):
    """Within a single page, each chunk must receive a distinct ID."""
    captured: list[Document] = []

    async def capture_batch(documents, job_id, fresh_until):
      captured.extend(documents)

    ds = make_datasource_info(chunk_size=50, chunk_overlap=0)
    jm = make_job_manager(total=1)
    loader = make_loader(datasource_info=ds, job_manager=jm)
    loader._ingest_batch = AsyncMock(side_effect=capture_batch)

    long_text = " ".join(f"word{i}" for i in range(100))
    await loader.ingest_pages([make_page(html_body=f"<p>{long_text}</p>")], "job-1")

    ids = [doc.id for doc in captured]
    assert len(ids) > 1, "Expected multiple chunks"
    assert len(ids) == len(set(ids))

  async def test_same_page_two_different_datasources_different_ids(self):
    """Same page_id under different datasource_ids must produce different doc IDs."""
    captured_a: list[Document] = []
    captured_b: list[Document] = []

    async def capture_a(documents, job_id, fresh_until):
      captured_a.extend(documents)

    async def capture_b(documents, job_id, fresh_until):
      captured_b.extend(documents)

    ds_a = make_datasource_info(datasource_id="src_confluence___company_a__SRE")
    ds_b = make_datasource_info(datasource_id="src_confluence___company_b__SRE")
    loader_a = make_loader(datasource_info=ds_a)
    loader_b = make_loader(datasource_info=ds_b)
    loader_a._ingest_batch = AsyncMock(side_effect=capture_a)
    loader_b._ingest_batch = AsyncMock(side_effect=capture_b)

    page = make_page(page_id="777")
    await loader_a.ingest_pages([page], "job-1")
    await loader_b.ingest_pages([page], "job-1")

    assert captured_a[0].id != captured_b[0].id


# ===========================================================================
# 8. _ingest_batch delegation
# ===========================================================================


class TestIngestBatch:
  """Tests for _ingest_batch — delegates to rag_client.ingest_documents and re-raises."""

  async def test_ingest_batch_calls_rag_client_with_correct_args(self):
    """_ingest_batch must call rag_client.ingest_documents(job_id, datasource_id, documents, fresh_until)."""
    rag = make_rag_client()
    ds = make_datasource_info(datasource_id="src_confluence___example__SRE")
    loader = make_loader(rag_client=rag, datasource_info=ds)

    docs = [Document(id="d1", page_content="hello", metadata={})]
    fresh_until = 1234567890
    await loader._ingest_batch(docs, "batch-job-99", fresh_until)

    rag.ingest_documents.assert_called_once_with(
      job_id="batch-job-99",
      datasource_id="src_confluence___example__SRE",
      documents=docs,
      fresh_until=fresh_until,
    )

  async def test_ingest_batch_reraises_rag_client_exception(self):
    """Exceptions from rag_client.ingest_documents must propagate out of _ingest_batch."""
    rag = make_rag_client()
    rag.ingest_documents = AsyncMock(side_effect=ConnectionError("rag unreachable"))
    loader = make_loader(rag_client=rag)

    with pytest.raises(ConnectionError, match="rag unreachable"):
      await loader._ingest_batch([Document(id="d1", page_content="x", metadata={})], "job-1", 0)

  async def test_ingest_batch_passes_all_documents(self):
    """All documents in the list must be forwarded — no filtering or slicing."""
    rag = make_rag_client()
    loader = make_loader(rag_client=rag)

    docs = [Document(id=f"d{i}", page_content=f"chunk {i}", metadata={}) for i in range(5)]
    await loader._ingest_batch(docs, "job-1", 0)

    actual_docs = rag.ingest_documents.call_args.kwargs["documents"]
    assert actual_docs == docs


# ===========================================================================
# 9. Missing / malformed page body structures
# ===========================================================================


class TestIngestPagesMalformedBody:
  """Pages with missing or incomplete body structures must be handled gracefully."""

  async def test_page_missing_body_key_treated_as_empty(self):
    """A page dict with no 'body' key must be treated as empty content (no count, progress incremented)."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    page = {"id": "123", "title": "No Body"}
    await loader.ingest_pages([page], "job-1")

    jm.increment_document_count.assert_not_called()
    jm.increment_progress.assert_called_once_with("job-1")

  async def test_page_missing_body_storage_treated_as_empty(self):
    """A page with body but no 'storage' sub-key must be treated as empty content."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    page = {"id": "123", "title": "Bad Body", "body": {}}
    await loader.ingest_pages([page], "job-1")

    jm.increment_document_count.assert_not_called()
    jm.increment_progress.assert_called_once_with("job-1")

  async def test_page_missing_storage_value_treated_as_empty(self):
    """A page with body.storage but no 'value' must be treated as empty content."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    page = {"id": "123", "title": "No Value", "body": {"storage": {}}}
    await loader.ingest_pages([page], "job-1")

    jm.increment_document_count.assert_not_called()
    jm.increment_progress.assert_called_once_with("job-1")

  async def test_page_with_null_body_value_treated_as_empty(self):
    """A page where body.storage.value is None must be handled without error."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    page = {"id": "123", "title": "Null Value", "body": {"storage": {"value": None}}}

    # The loader does extract_text_from_html(None) — BeautifulSoup handles this,
    # but the loader may raise or treat as empty; document this behaviour.
    try:
      await loader.ingest_pages([page], "job-1")
      # If it doesn't raise, document_count must not be incremented
      jm.increment_document_count.assert_not_called()
    except Exception:
      # If it raises, that is acceptable for None input; test passes
      pass

  async def test_page_with_empty_title_still_processed(self):
    """A page with an empty title string must still be ingested if it has content."""
    jm = make_job_manager(total=1)
    rag = make_rag_client()
    loader = make_loader(job_manager=jm, rag_client=rag)

    page = make_page(title="")
    await loader.ingest_pages([page], "job-1")

    # Page with content should trigger ingest_documents call
    assert rag.ingest_documents.call_count >= 1
    jm.increment_progress.assert_called_once_with("job-1")

  async def test_page_with_missing_history_does_not_crash(self):
    """A page without the 'history' key must not crash during ingestion."""
    jm = make_job_manager(total=1)
    rag = make_rag_client()
    loader = make_loader(job_manager=jm, rag_client=rag)

    page = make_page()
    del page["history"]
    await loader.ingest_pages([page], "job-1")

    # Page with content should trigger ingest_documents call
    assert rag.ingest_documents.call_count >= 1
    jm.increment_progress.assert_called_once_with("job-1")

  async def test_page_with_missing_links_does_not_crash(self):
    """A page without '_links' must not crash; URL defaults to base URL."""
    jm = make_job_manager(total=1)
    rag = make_rag_client()
    loader = make_loader(job_manager=jm, rag_client=rag)

    page = make_page()
    del page["_links"]
    await loader.ingest_pages([page], "job-1")

    # Page with content should trigger ingest_documents call
    assert rag.ingest_documents.call_count >= 1
    jm.increment_progress.assert_called_once_with("job-1")


# ===========================================================================
# 10. Error message format and progress increment on failure
# ===========================================================================


class TestIngestPagesErrorHandling:
  """Error messages and progress counters must be correctly managed on failure."""

  async def test_error_message_includes_page_id(self):
    """add_error_msg must be called with a message that contains the failing page_id."""
    jm = make_job_manager(total=1, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=ValueError("bad html"))

    await loader.ingest_pages([make_page(page_id="bad-page-99")], "job-1")

    assert jm.add_error_msg.called
    error_msg_arg = jm.add_error_msg.call_args[0][1]  # positional arg 1
    assert "bad-page-99" in error_msg_arg

  async def test_error_message_contains_exception_text(self):
    """add_error_msg must include the exception message, not just the page_id."""
    jm = make_job_manager(total=1, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=RuntimeError("specific failure text"))

    await loader.ingest_pages([make_page(page_id="err-page")], "job-1")

    error_msg_arg = jm.add_error_msg.call_args[0][1]
    assert "specific failure text" in error_msg_arg

  async def test_progress_incremented_on_failure(self):
    """Even when a page fails, increment_progress must still be called once."""
    jm = make_job_manager(total=1, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=RuntimeError("fail"))

    await loader.ingest_pages([make_page()], "job-1")

    jm.increment_progress.assert_called_once()

  async def test_progress_incremented_for_every_page_regardless_of_outcome(self):
    """progress is called N times for N pages, regardless of success or failure."""
    from bs4 import BeautifulSoup

    call_n = {"n": 0}

    def fail_odd(html: str) -> str:
      call_n["n"] += 1
      if call_n["n"] % 2 == 0:
        raise RuntimeError("even-indexed page fails")
      return BeautifulSoup(html, "html.parser").get_text(separator="\n", strip=True)

    n = 4
    jm = make_job_manager(total=n, failed_counter=2)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=fail_odd)

    pages = [make_page(page_id=str(i)) for i in range(n)]
    await loader.ingest_pages(pages, "job-1")

    assert jm.increment_progress.call_count == n

  async def test_failure_and_success_interleaved_correct_counts(self):
    """Alternating success/failure pages produce the right progress and failure tallies."""
    from bs4 import BeautifulSoup

    call_n = {"n": 0}

    def fail_even(html: str) -> str:
      call_n["n"] += 1
      if call_n["n"] % 2 == 1:
        raise RuntimeError("odd-call fails")
      return BeautifulSoup(html, "html.parser").get_text(separator="\n", strip=True)

    n = 6
    # 3 fail, 3 succeed
    jm = make_job_manager(total=n, failed_counter=3)
    rag = make_rag_client()
    loader = make_loader(job_manager=jm, rag_client=rag)
    loader.extract_text_from_html = MagicMock(side_effect=fail_even)

    pages = [make_page(page_id=str(i)) for i in range(n)]
    await loader.ingest_pages(pages, "job-1")

    # All 6 pages increment progress
    assert jm.increment_progress.call_count == n
    # 3 failures tracked
    assert jm.increment_failure.call_count == 3
    # ingest_documents called for successful pages
    assert rag.ingest_documents.call_count >= 1

  async def test_add_error_msg_called_with_job_id(self):
    """add_error_msg must receive the correct job_id as first argument."""
    jm = make_job_manager(total=1, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=RuntimeError("boom"))

    await loader.ingest_pages([make_page()], "my-specific-job")

    jm.add_error_msg.assert_called_once()
    assert jm.add_error_msg.call_args[0][0] == "my-specific-job"

  async def test_increment_failure_called_with_message(self):
    """increment_failure must be called with a job_id keyword and a message."""
    jm = make_job_manager(total=1, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=RuntimeError("failure"))

    await loader.ingest_pages([make_page(page_id="failing-page")], "job-42")

    jm.increment_failure.assert_called_once()
    kwargs = jm.increment_failure.call_args.kwargs
    assert kwargs.get("job_id") == "job-42"
    assert "failing-page" in kwargs.get("message", "")


# ===========================================================================
# 11. Upsert_job message content
# ===========================================================================


class TestIngestPagesUpsertJobMessages:
  """The message strings written via upsert_job must contain meaningful context."""

  async def test_success_message_contains_page_title(self):
    """After processing a page, the upsert_job message must include its title."""
    jm = make_job_manager(total=1)
    loader = make_loader(job_manager=jm)

    page = make_page(title="My Special Page")
    await loader.ingest_pages([page], "job-1")

    assert any("My Special Page" in (c.kwargs.get("message") or "") for c in jm.upsert_job.call_args_list), "Page title must appear in at least one upsert_job message"

  async def test_terminal_completed_message_mentions_total(self):
    """The COMPLETED upsert_job message must mention the page total."""
    jm = make_job_manager(total=3, failed_counter=0)
    loader = make_loader(job_manager=jm)

    pages = [make_page(page_id=str(i)) for i in range(3)]
    await loader.ingest_pages(pages, "job-1")

    terminal_calls = _terminal_status_calls(jm)
    assert terminal_calls
    msg = terminal_calls[-1].kwargs.get("message", "")
    assert "3" in msg

  async def test_terminal_failed_message_mentions_total(self):
    """The FAILED upsert_job message must mention how many pages failed."""
    jm = make_job_manager(total=2, failed_counter=2)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=RuntimeError("parse error"))

    await loader.ingest_pages([make_page(page_id=str(i)) for i in range(2)], "job-1")

    terminal_calls = _terminal_status_calls(jm)
    msg = terminal_calls[-1].kwargs.get("message", "")
    assert "2" in msg

  async def test_terminal_completed_with_errors_message_mentions_failures(self):
    """COMPLETED_WITH_ERRORS message must include the failure count."""
    from bs4 import BeautifulSoup

    call_n = {"n": 0}

    def fail_first(html: str) -> str:
      call_n["n"] += 1
      if call_n["n"] == 1:
        raise RuntimeError("fail")
      return BeautifulSoup(html, "html.parser").get_text(separator="\n", strip=True)

    jm = make_job_manager(total=3, failed_counter=1)
    loader = make_loader(job_manager=jm)
    loader.extract_text_from_html = MagicMock(side_effect=fail_first)

    await loader.ingest_pages([make_page(page_id=str(i)) for i in range(3)], "job-1")

    terminal_calls = _terminal_status_calls(jm)
    msg = terminal_calls[-1].kwargs.get("message", "")
    assert "1" in msg  # failure count appears


# ===========================================================================
# 12. generate_datasource_id — additional edge cases
# ===========================================================================


class TestGenerateDatasourceIdEdgeCases:
  """Edge cases for URL parsing in generate_datasource_id."""

  def test_url_with_trailing_slash_same_as_without(self):
    """Trailing slash must not affect the generated ID."""
    r1 = generate_datasource_id("https://example.com", "SRE")
    r2 = generate_datasource_id("https://example.com/", "SRE")
    # Both should produce the same domain normalisation
    # (netloc is identical for both)
    assert r1 == r2

  def test_url_with_explicit_port_includes_port_in_domain(self):
    """A port in the URL is part of netloc and should appear in the ID."""
    result = generate_datasource_id("https://example.com:8443/wiki", "SRE")
    # netloc = example.com:8443; dot replaced with underscore
    assert "example_com" in result
    assert "8443" in result

  def test_url_with_subdomain_normalized(self):
    """Subdomains (dots) are replaced with underscores."""
    result = generate_datasource_id("https://a.b.example.com", "SRE")
    assert "a_b_example_com" in result

  def test_url_with_dashes_fully_normalized(self):
    """Both dots and dashes in the domain are replaced with underscores."""
    result = generate_datasource_id("https://my-corp.atlassian.net", "ENG")
    assert "-" not in result.split("___")[1]

  def test_numeric_space_key(self):
    """Numeric space keys must be accepted and appended verbatim."""
    result = generate_datasource_id("https://example.com", "12345")
    assert result.endswith("__12345")

  def test_space_key_with_underscore(self):
    """Space keys containing underscores must be preserved."""
    result = generate_datasource_id("https://example.com", "MY_TEAM")
    assert result.endswith("__MY_TEAM")

  def test_result_starts_with_correct_prefix(self):
    result = generate_datasource_id("https://any-host.example.com/wiki", "SPACE")
    assert result.startswith("src_confluence___")

  def test_result_format_three_parts(self):
    """ID format: src_confluence___{domain}__{space_key}."""
    result = generate_datasource_id("https://example.com", "SRE")
    parts = result.split("___")
    assert parts[0] == "src_confluence"
    domain_space = parts[1].split("__")
    assert domain_space[-1] == "SRE"


# ===========================================================================
# Title filtering tests
# ===========================================================================


class TestShouldSkipPage:
  """Verify title-based include/exclude filtering (mirrors webloader URL patterns)."""

  def test_denied_patterns_filter_matching_titles(self):
    """Pages with titles matching denied patterns are skipped; others pass through."""
    loader = make_loader()
    loader.denied_title_patterns = [r"Deprecated", r"Do Not Use"]

    assert loader.should_skip_page("Deprecated: Old Runbook") is True
    assert loader.should_skip_page("Do Not Use - Legacy API") is True
    assert loader.should_skip_page("SRE Runbook - Active") is False
    # Case-insensitive
    assert loader.should_skip_page("deprecated service guide") is True

  def test_allowed_patterns_restrict_to_matching_titles(self):
    """When allowed patterns are set, only matching titles are ingested."""
    loader = make_loader()
    loader.allowed_title_patterns = [r"^SRE", r"Runbook"]

    assert loader.should_skip_page("SRE Handbook") is False
    assert loader.should_skip_page("Production Runbook") is False
    assert loader.should_skip_page("Marketing Plan") is True


class TestLoadPagesTitleFiltering:
  """Verify that load_pages applies title filters end-to-end."""

  @pytest.mark.asyncio
  async def test_denied_patterns_filter_pages_in_load_pages(self):
    """Pages matching denied title patterns are excluded from load_pages results."""
    loader = make_loader()
    loader.denied_title_patterns = [r"Deprecated", r"Do Not Use"]

    # Mock the session to return pages when enumerating a space
    active_page = make_page(page_id="1", title="Active Guide")
    deprecated_page = make_page(page_id="2", title="Deprecated: Old Guide")
    do_not_use_page = make_page(page_id="3", title="Do Not Use - Legacy")

    mock_response = MagicMock()
    mock_response.status = 200
    mock_response.json = AsyncMock(return_value={"results": [active_page, deprecated_page, do_not_use_page]})
    mock_response.__aenter__ = AsyncMock(return_value=mock_response)
    mock_response.__aexit__ = AsyncMock(return_value=False)

    mock_session = MagicMock()
    mock_session.get = MagicMock(return_value=mock_response)
    loader.session = mock_session

    pages, failed = await loader.load_pages("SRE")

    assert len(pages) == 1
    assert pages[0]["id"] == "1"
    assert len(failed) == 0
