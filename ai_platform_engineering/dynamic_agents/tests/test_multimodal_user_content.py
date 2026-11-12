"""Multimodal user-turn construction for chat input.

Verifies ``_build_user_content`` builds a LangChain-standard content list:
images become ``image`` blocks and supported documents become ``file``
blocks, so the model reads every attachable file. Files Bedrock cannot
ingest are skipped, and — when the selected model declares it doesn't accept
a modality — files are dropped so a no-vision model degrades cleanly to text.
Both kinds of drop are reported in the returned ``skipped`` list so the caller
can surface a warning to the user.
"""

from __future__ import annotations

import base64

from dynamic_agents.models import InputFile
from dynamic_agents.services.agent_runtime import (
    SKIP_FILE_TOO_LARGE,
    SKIP_NOT_ACCEPTED_BY_MODEL,
    SKIP_TOO_MANY_FILES,
    SKIP_TURN_TOO_LARGE,
    SKIP_UNSUPPORTED_BY_PROVIDER,
    SkippedFile,
    _build_user_content,
    _skipped_file_warning,
    _skipped_files_notice,
)
from dynamic_agents.services.model_capabilities import ModelCapabilities


def _b64_of_size(n_bytes: int) -> str:
    """Base64 string whose decoded size is ~n_bytes (for size-limit tests)."""
    # base64 encodes 3 raw bytes -> 4 chars; padding is stripped by the
    # estimator, so a string of ceil(n*4/3) 'A's decodes to ~n bytes.
    return "A" * ((n_bytes + 2) // 3 * 4)


def test_single_base64_image_builds_content_list():
    files = [InputFile(mime_type="image/png", data="aGVsbG8=", name="a.png")]
    content, skipped = _build_user_content("describe this", files)

    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "describe this"}
    assert content[1] == {"type": "image", "mime_type": "image/png", "base64": "aGVsbG8="}
    assert skipped == []


def test_multiple_images_each_get_a_block():
    files = [
        InputFile(mime_type="image/png", data="Zm9v"),
        InputFile(mime_type="image/webp", data="YmFy"),
    ]
    content, skipped = _build_user_content("compare", files)

    assert isinstance(content, list)
    # 1 text block + 2 image blocks
    assert len(content) == 3
    assert [b["type"] for b in content] == ["text", "image", "image"]
    assert skipped == []


def test_document_becomes_file_block_with_name():
    files = [InputFile(mime_type="application/pdf", data="cGRm", name="report.pdf")]
    content, skipped = _build_user_content("summarize", files)

    assert isinstance(content, list)
    assert content[1] == {
        "type": "file",
        "mime_type": "application/pdf",
        "base64": "cGRm",
        "name": "report.pdf",
    }
    assert skipped == []


def test_mixed_image_and_document_both_kept():
    files = [
        InputFile(mime_type="text/plain", data="cGxhaW4=", name="notes.txt"),
        InputFile(mime_type="image/png", data="aW1n"),
    ]
    content, skipped = _build_user_content("mixed", files)

    assert isinstance(content, list)
    # text + a document block + an image block
    assert len(content) == 3
    assert [b["type"] for b in content] == ["text", "file", "image"]
    assert skipped == []


# --- Anthropic text-source shaping (Bedrock rejects non-PDF base64 docs) ------

_ANTHROPIC_MODEL = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
_CONVERSE_MODEL = "us.amazon.nova-pro-v1:0"


def test_anthropic_text_doc_sent_as_text_source_not_base64():
    # On the Anthropic client a text/plain doc as a base64 document source is
    # rejected ("Input should be 'application/pdf'"). It must go as a text source
    # carrying the decoded content, with media_type normalized to text/plain.
    data = base64.b64encode(b"hello world").decode()
    files = [InputFile(mime_type="text/plain", data=data, name="notes.txt")]

    content, skipped = _build_user_content("read", files, model_id=_ANTHROPIC_MODEL)

    assert isinstance(content, list)
    block = content[1]
    # A v1-native ``text-plain`` block: langchain-anthropic renders it to a
    # document/text source. A legacy ``source_type="text"`` block would instead
    # be routed through langchain-core's v0->v1 converter, which reads the text
    # from ``url`` and raises ``KeyError: 'url'`` here.
    assert block["type"] == "text-plain"
    assert block["mime_type"] == "text/plain"
    assert block["text"] == "hello world"
    assert "source_type" not in block
    assert "base64" not in block
    assert skipped == []


def test_anthropic_accepts_xml_as_text_source():
    # XML has no Bedrock document format, but the Anthropic client reads it as a
    # text source. The original tags survive in the text; media_type is text/plain.
    data = base64.b64encode(b"<root><a/></root>").decode()
    files = [InputFile(mime_type="text/xml", data=data, name="win.xml")]

    content, skipped = _build_user_content("parse", files, model_id=_ANTHROPIC_MODEL)

    assert isinstance(content, list)
    block = content[1]
    assert block["type"] == "text-plain"
    assert block["mime_type"] == "text/plain"
    assert block["text"] == "<root><a/></root>"
    assert "source_type" not in block
    assert skipped == []


def test_anthropic_pdf_still_rides_as_base64():
    # PDF is the one document type Anthropic accepts as base64 — leave it alone.
    files = [InputFile(mime_type="application/pdf", data="cGRm", name="r.pdf")]
    content, skipped = _build_user_content("summarize", files, model_id=_ANTHROPIC_MODEL)

    block = content[1]
    assert block["base64"] == "cGRm"
    assert "source_type" not in block
    assert skipped == []


def test_anthropic_text_block_survives_real_langchain_pipeline():
    # Regression for the dev failure: a unit test asserting our block shape in
    # isolation passed, but prod raised ``KeyError: 'url'``. The block we emit is
    # first run through langchain-core's ``_normalize_messages`` (v0->v1) and then
    # langchain-anthropic's ``_format_messages`` before it ever reaches Bedrock.
    # Drive it through both real functions so the contract is verified end-to-end.
    import importlib.util

    import pytest

    if (
        importlib.util.find_spec("langchain_core.language_models._utils") is None
        or importlib.util.find_spec("langchain_anthropic") is None
    ):
        pytest.skip("langchain-core/-anthropic not importable in this environment")

    from langchain_anthropic.chat_models import _format_messages  # type: ignore
    from langchain_core.language_models._utils import _normalize_messages
    from langchain_core.messages import HumanMessage

    data = base64.b64encode(b"hello world").decode()
    files = [InputFile(mime_type="text/plain", data=data, name="notes.txt")]
    content, _ = _build_user_content("read", files, model_id=_ANTHROPIC_MODEL)

    normalized = _normalize_messages([HumanMessage(content=content)])
    _system, formatted = _format_messages(normalized, model=_ANTHROPIC_MODEL)

    # The text doc lands as an Anthropic document/text source, not a base64 doc
    # (which Bedrock rejects with "Input should be 'application/pdf'").
    doc_blocks = [
        b
        for m in formatted
        for b in (m["content"] if isinstance(m["content"], list) else [])
        if isinstance(b, dict) and b.get("type") == "document"
    ]
    assert doc_blocks, f"no document block produced: {formatted}"
    source = doc_blocks[0]["source"]
    assert source["type"] == "text"
    assert source["media_type"] == "text/plain"
    assert source["data"] == "hello world"


def test_converse_keeps_text_as_base64_and_skips_xml():
    # Non-anthropic (Converse) client: text docs still ride as base64 (Converse
    # accepts them), and XML is skipped as unsupported rather than erroring.
    txt = base64.b64encode(b"plain").decode()
    files = [
        InputFile(mime_type="text/plain", data=txt, name="n.txt"),
        InputFile(mime_type="text/xml", data=base64.b64encode(b"<a/>").decode(), name="w.xml"),
    ]
    content, skipped = _build_user_content("x", files, model_id=_CONVERSE_MODEL)

    assert isinstance(content, list)
    assert content[1] == {"type": "file", "mime_type": "text/plain", "base64": txt, "name": "n.txt"}
    assert [s.name for s in skipped] == ["w.xml"]
    assert skipped[0].reason == SKIP_UNSUPPORTED_BY_PROVIDER


def test_no_model_id_preserves_legacy_base64_shape():
    # model_id=None (the unit-test default) must not trigger text-source shaping.
    data = base64.b64encode(b"legacy").decode()
    files = [InputFile(mime_type="text/plain", data=data, name="n.txt")]
    content, _ = _build_user_content("x", files)  # no model_id

    assert content[1]["base64"] == data
    assert "source_type" not in content[1]


def test_unsupported_type_is_skipped_and_degrades_to_string():
    # A lone type Bedrock cannot ingest leaves no attachable block, so we
    # fall back to the plain string rather than send a text-only list.
    files = [InputFile(mime_type="application/zip", data="emlw", name="a.zip")]
    content, skipped = _build_user_content("here", files)

    assert content == "here"
    assert len(skipped) == 1
    assert skipped[0].name == "a.zip"
    assert skipped[0].reason == SKIP_UNSUPPORTED_BY_PROVIDER


# --- Model-capability degradation (ticket 2032) ------------------------------


def test_no_vision_model_drops_image_and_reports_skip():
    # Provider supports image/png, but the agent's model declares it doesn't
    # accept images — the file is dropped and reported, and with no other file
    # the content degrades to the plain text string.
    caps = ModelCapabilities(accepts_images=False, accepts_documents=True)
    files = [InputFile(mime_type="image/png", data="aW1n", name="chart.png")]

    content, skipped = _build_user_content("what's in this?", files, caps)

    assert content == "what's in this?"
    assert len(skipped) == 1
    assert skipped[0].name == "chart.png"
    assert skipped[0].reason == SKIP_NOT_ACCEPTED_BY_MODEL


def test_no_vision_model_still_keeps_documents():
    # A model that takes documents but not images keeps the PDF and drops only
    # the image.
    caps = ModelCapabilities(accepts_images=False, accepts_documents=True)
    files = [
        InputFile(mime_type="image/png", data="aW1n", name="chart.png"),
        InputFile(mime_type="application/pdf", data="cGRm", name="report.pdf"),
    ]

    content, skipped = _build_user_content("review", files, caps)

    assert isinstance(content, list)
    assert [b["type"] for b in content] == ["text", "file"]
    assert [s.reason for s in skipped] == [SKIP_NOT_ACCEPTED_BY_MODEL]
    assert skipped[0].name == "chart.png"


def test_none_capabilities_is_permissive():
    # capabilities=None must preserve legacy behavior: everything the provider
    # supports is accepted.
    files = [InputFile(mime_type="image/png", data="aW1n", name="x.png")]
    content, skipped = _build_user_content("hi", files, None)

    assert isinstance(content, list)
    assert content[1]["type"] == "image"
    assert skipped == []


# --- Warning copy names the model (Kevin nit #1) -----------------------------


def test_warning_names_the_model():
    skip = SkippedFile("chart.png", "image/png", SKIP_NOT_ACCEPTED_BY_MODEL)
    msg = _skipped_file_warning(skip, model_id="gpt-5.4")
    assert "gpt-5.4" in msg
    assert "doesn't accept image input" in msg
    # No model id -> no empty parens.
    assert "()" not in _skipped_file_warning(skip)


# --- Model-facing notice (Kevin #3 / Erik #2): don't fail silently -----------


def test_skipped_files_notice_lists_each_file():
    skipped = [
        SkippedFile("apple.png", "image/png", SKIP_NOT_ACCEPTED_BY_MODEL),
        SkippedFile("big.pdf", "application/pdf", SKIP_FILE_TOO_LARGE),
    ]
    notice = _skipped_files_notice(skipped, model_id="gpt-5.4", max_file_bytes=5 * 1024 * 1024)
    assert notice.startswith("[System note:")
    assert "2 attached file(s)" in notice
    assert "apple.png" in notice and "big.pdf" in notice
    assert "gpt-5.4" in notice


def test_skipped_files_notice_empty_when_nothing_skipped():
    assert _skipped_files_notice([]) == ""


# --- Input guardrails (Kevin #2 / #2a): count + size limits ------------------


def test_count_limit_drops_overflow_keeps_the_rest():
    files = [InputFile(mime_type="image/png", data="aW1n", name=f"{i}.png") for i in range(12)]
    content, skipped = _build_user_content("many", files, max_files=10)

    assert isinstance(content, list)
    # 1 text block + 10 kept image blocks
    assert len([b for b in content if b["type"] == "image"]) == 10
    assert len(skipped) == 2
    assert {s.reason for s in skipped} == {SKIP_TOO_MANY_FILES}
    # The overflow is the tail (files 10 and 11).
    assert [s.name for s in skipped] == ["10.png", "11.png"]


def test_per_file_size_limit_drops_oversize_keeps_others():
    files = [
        InputFile(mime_type="image/png", data=_b64_of_size(10 * 1024 * 1024), name="huge.png"),
        InputFile(mime_type="image/png", data="aW1n", name="tiny.png"),
    ]
    content, skipped = _build_user_content("x", files, max_file_bytes=5 * 1024 * 1024)

    assert isinstance(content, list)
    assert [b for b in content if b["type"] == "image"][0]  # tiny survived
    assert len(skipped) == 1
    assert skipped[0].name == "huge.png"
    assert skipped[0].reason == SKIP_FILE_TOO_LARGE


def test_turn_size_limit_drops_the_breaching_file():
    # Two ~3MB files under a 5MB turn cap: the first fits, the second breaches.
    files = [
        InputFile(mime_type="image/png", data=_b64_of_size(3 * 1024 * 1024), name="first.png"),
        InputFile(mime_type="image/png", data=_b64_of_size(3 * 1024 * 1024), name="second.png"),
    ]
    content, skipped = _build_user_content("x", files, max_turn_bytes=5 * 1024 * 1024)

    assert isinstance(content, list)
    assert len([b for b in content if b["type"] == "image"]) == 1
    assert len(skipped) == 1
    assert skipped[0].name == "second.png"
    assert skipped[0].reason == SKIP_TURN_TOO_LARGE


def test_zero_limits_disable_guards():
    # Defaults are 0 (unlimited) -> a large, many-file set is fully kept.
    files = [
        InputFile(mime_type="image/png", data=_b64_of_size(50 * 1024 * 1024), name=f"{i}.png")
        for i in range(25)
    ]
    content, skipped = _build_user_content("x", files)  # no limits passed

    assert isinstance(content, list)
    assert len([b for b in content if b["type"] == "image"]) == 25
    assert skipped == []
