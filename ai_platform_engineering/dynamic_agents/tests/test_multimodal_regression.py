"""Regression harness: real fixtures must build the right model block per model.

The 0.5.65 image regression shipped because nothing asserted, end to end over a
*real* file, that a supported attachment produces the expected multimodal block
for the model handling it. This harness closes that gap. It reads the real
fixtures under ``tests/fixtures/multimodal/`` (a JPEG, a PDF, a text file),
feeds them through ``_build_user_content`` for each model-capability class, and
pins:

- a full-multimodal model keeps every fixture as its correct block type
  (image -> ``image`` block, documents -> ``file`` blocks), with nothing skipped
  — the exact invariant the regression violated;
- a no-vision model drops the image with ``not_accepted_by_model`` and keeps docs;
- a no-document model drops the docs with ``not_accepted_by_model`` and keeps the
  image;
- every model id we actually deploy (``DEFAULT_MODEL_CAPABILITIES``) resolves to a
  profile that keeps all three fixtures.

All assertions are pure and network-free, so this runs in the standard unit job.
"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from dynamic_agents.models import InputFile
from dynamic_agents.services.agent_runtime import (
    SKIP_NOT_ACCEPTED_BY_MODEL,
    _build_user_content,
)
from dynamic_agents.services.model_capabilities import (
    DEFAULT_MODEL_CAPABILITIES,
    ModelCapabilities,
    get_model_capabilities,
)

# tests/fixtures/multimodal lives at the repo root; this file is three levels
# down under ai_platform_engineering/dynamic_agents/tests/.
_FIXTURE_DIR = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "multimodal"

_IMAGE = ("sample.jpeg", "image/jpeg")
_PDF = ("sample.pdf", "application/pdf")
_TXT = ("sample.txt", "text/plain")


def _input_file(filename: str, mime_type: str) -> InputFile:
    """Load a real fixture into an InputFile with base64-encoded bytes."""
    raw = (_FIXTURE_DIR / filename).read_bytes()
    return InputFile(
        mime_type=mime_type,
        data=base64.b64encode(raw).decode(),
        name=filename,
    )


def test_fixtures_exist():
    # Guard against a silently-missing fixture masquerading as a passing suite.
    for filename, _ in (_IMAGE, _PDF, _TXT):
        assert (_FIXTURE_DIR / filename).is_file(), f"missing fixture {filename}"


def test_full_multimodal_model_keeps_every_fixture():
    # The regression case: a fully-capable model must build one block per file,
    # image as an ``image`` block and documents as ``file`` blocks, dropping
    # nothing. This is the assertion that would have failed on 0.5.65.
    caps = ModelCapabilities(accepts_images=True, accepts_documents=True)
    files = [_input_file(*_IMAGE), _input_file(*_PDF), _input_file(*_TXT)]

    content, skipped = _build_user_content("describe these", files, caps)

    assert isinstance(content, list)
    assert content[0]["type"] == "text"
    # text block + one block per fixture, in order.
    assert [b["type"] for b in content] == ["text", "image", "file", "file"]

    image_block = content[1]
    assert image_block["type"] == "image"
    assert image_block["mime_type"] == "image/jpeg"
    assert image_block["base64"] == files[0].data

    pdf_block = content[2]
    assert pdf_block == {
        "type": "file",
        "mime_type": "application/pdf",
        "base64": files[1].data,
        "name": "sample.pdf",
    }
    txt_block = content[3]
    assert txt_block == {
        "type": "file",
        "mime_type": "text/plain",
        "base64": files[2].data,
        "name": "sample.txt",
    }

    assert skipped == []


def test_no_vision_model_drops_image_keeps_documents():
    caps = ModelCapabilities(accepts_images=False, accepts_documents=True)
    files = [_input_file(*_IMAGE), _input_file(*_PDF), _input_file(*_TXT)]

    content, skipped = _build_user_content("review", files, caps)

    assert isinstance(content, list)
    # image gone; both documents kept.
    assert [b["type"] for b in content] == ["text", "file", "file"]
    assert [s.name for s in skipped] == ["sample.jpeg"]
    assert skipped[0].reason == SKIP_NOT_ACCEPTED_BY_MODEL


def test_no_document_model_drops_documents_keeps_image():
    caps = ModelCapabilities(accepts_images=True, accepts_documents=False)
    files = [_input_file(*_IMAGE), _input_file(*_PDF), _input_file(*_TXT)]

    content, skipped = _build_user_content("look", files, caps)

    assert isinstance(content, list)
    # only the image survives.
    assert [b["type"] for b in content] == ["text", "image"]
    assert sorted(s.name for s in skipped) == ["sample.pdf", "sample.txt"]
    assert {s.reason for s in skipped} == {SKIP_NOT_ACCEPTED_BY_MODEL}


@pytest.mark.parametrize("model_key", sorted(DEFAULT_MODEL_CAPABILITIES))
def test_every_deployed_model_keeps_all_fixtures(model_key):
    # Each model id/prefix we ship in the seed registry must resolve to a
    # profile that keeps all three fixtures — a future capability edit that
    # would silently start dropping a supported type fails here.
    caps = get_model_capabilities(model_key)
    files = [_input_file(*_IMAGE), _input_file(*_PDF), _input_file(*_TXT)]

    content, skipped = _build_user_content("check", files, caps)

    assert isinstance(content, list)
    assert [b["type"] for b in content] == ["text", "image", "file", "file"]
    assert skipped == []
