"""The existing logical file store carries exact binary bytes, with bounded IO."""

import base64
import hashlib

import pytest

from dynamic_agents.services.file_content import decode_file_content, file_data_from_bytes, verify_file_receipt


@pytest.mark.parametrize("raw", [b"", b"Example text\n", b"\xff\x00\xfePK\x03\x04", bytes(range(256))])
def test_file_record_round_trip(raw: bytes) -> None:
    assert decode_file_content(file_data_from_bytes(raw), maximum=1024) == raw


def test_existing_deepagents_line_list_decodes_without_format_change() -> None:
    assert decode_file_content({"content": ["first", "second"]}, maximum=1024) == b"first\nsecond"


@pytest.mark.parametrize("value", [
    {"content": "not-base64", "encoding": "base64"},
    {"content": "Zh==", "encoding": "base64"},
    {"content": "AA==\n", "encoding": "base64"},
    {"content": "AA==", "encoding": "binary"},
    {"content": ["AA=="], "encoding": "base64"},
])
def test_invalid_records_are_not_decoded(value: dict) -> None:
    with pytest.raises(ValueError):
        decode_file_content(value, maximum=1024)


def test_decoded_size_bound_precedes_return_and_receipt_matches_exact_bytes() -> None:
    raw = b"\xff" * 4
    with pytest.raises(ValueError, match="supported size"):
        decode_file_content({"content": base64.b64encode(raw).decode(), "encoding": "base64"}, maximum=3)
    verify_file_receipt({"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}, raw)
    with pytest.raises(ValueError, match="receipt"):
        verify_file_receipt({"bytes": len(raw), "sha256": "0" * 64}, raw)
