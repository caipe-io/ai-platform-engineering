"""Byte-preserving content in the existing logical filesystem's JSON records."""

from __future__ import annotations

import base64
import binascii
import hashlib
from typing import Any

from deepagents.backends.utils import create_file_data

MAX_BINARY_FILE_BYTES = 512 * 1024


def decode_file_content(value: dict[str, Any], *, maximum: int) -> bytes:
    content = value.get("content")
    encoding = value.get("encoding", "utf-8")
    if isinstance(content, list) and encoding == "utf-8" and all(isinstance(line, str) for line in content):
        content = "\n".join(content)
    if not isinstance(content, str):
        raise ValueError("The file content is invalid")
    if encoding == "base64":
        if len(content) > 4 * ((maximum + 2) // 3):
            raise ValueError("The file exceeds its supported size")
        try:
            data = base64.b64decode(content, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("The binary file content is invalid") from None
        if base64.b64encode(data).decode("ascii") != content:
            raise ValueError("The binary file content is not canonical base64")
    elif encoding == "utf-8":
        try:
            data = content.encode("utf-8")
        except UnicodeError:
            raise ValueError("The file content is not valid UTF-8") from None
    else:
        raise ValueError("The file encoding is not supported")
    if len(data) > maximum:
        raise ValueError("The file exceeds its supported size")
    return data


def file_data_from_bytes(data: bytes) -> dict[str, Any]:
    """Keep native text records compatible; encode all other bytes explicitly."""
    try:
        text = data.decode("utf-8")
        if any(ord(char) < 32 and char not in "\n\r\t" for char in text):
            raise ValueError("Binary control characters")
    except (UnicodeError, ValueError):
        return {**create_file_data(base64.b64encode(data).decode("ascii")), "encoding": "base64"}
    return create_file_data(text)


def verify_file_receipt(value: dict[str, Any], data: bytes) -> None:
    if type(value.get("bytes")) is not int or value["bytes"] != len(data) or value.get("sha256") != hashlib.sha256(data).hexdigest():
        raise ValueError("The workspace artifact receipt does not match its bytes")
