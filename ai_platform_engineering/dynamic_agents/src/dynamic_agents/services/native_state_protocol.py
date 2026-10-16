"""Bounded framing for opaque provider-native state, never agent messages."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

STATE_FORMAT = "caipe.native-state.v1"
STATE_ARCHIVE = "pax-tar"
MAX_STATE_BYTES = 256 * 1024 * 1024
MAX_STATE_FILE_BYTES = 128 * 1024 * 1024
MAX_STATE_MEMBERS = 20_000
MAX_STATE_CHUNK = 65_536
MAX_STATE_LINE = 96 * 1024
STATE_EXCLUDED_PATHS = [".caipe/acp.lock", ".caipe/state.lock", ".caipe/native-state", ".codex/auth.json", ".claude/.credentials.json"]
STATE_CONTRACT = {
    "format": STATE_FORMAT, "archive": STATE_ARCHIVE, "max_bytes": MAX_STATE_BYTES,
    "max_expanded_bytes": MAX_STATE_BYTES, "max_file_bytes": MAX_STATE_FILE_BYTES,
    "max_members": MAX_STATE_MEMBERS, "excluded_paths": STATE_EXCLUDED_PATHS,
}


class NativeStateProtocolError(ValueError):
    """An archive is incomplete, changed or outside the released contract."""


def _integer(value: Any, maximum: int) -> bool:
    return type(value) is int and 0 <= value <= maximum


def validate_checkpoint_id(value: Any) -> str:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError
    except (ValueError, AttributeError):
        raise NativeStateProtocolError("The native-state checkpoint identity is invalid") from None
    return value


def validate_state_header(frame: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
    if (frame.get("type") != "header" or frame.get("format") != STATE_FORMAT or frame.get("archive") != STATE_ARCHIVE
            or any(frame.get(key) != value for key, value in expected.items())
            or not isinstance(frame.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", frame["sha256"])
            or not _integer(frame.get("bytes"), MAX_STATE_BYTES) or frame["bytes"] == 0):
        raise NativeStateProtocolError("The native-state archive header does not match its bound session")
    validate_checkpoint_id(frame.get("checkpoint_id"))
    exclusions = frame.get("excluded_paths")
    if exclusions != STATE_EXCLUDED_PATHS:
        raise NativeStateProtocolError("The native-state exclusions are invalid")
    versions = frame.get("runtime_versions")
    if (not isinstance(versions, dict) or not 1 <= len(versions) <= 16
            or any(not isinstance(key, str) or not key or len(key) > 128
                   or not isinstance(value, str) or not value or len(value) > 1024 for key, value in versions.items())):
        raise NativeStateProtocolError("The native-state runtime versions are invalid")
    return dict(frame)


async def state_frames(chunks: AsyncIterable[bytes]) -> AsyncIterator[dict[str, Any]]:
    """Bound each line before decoding; a malicious unterminated line stays bounded."""
    buffer = bytearray()
    async for chunk in chunks:
        view = memoryview(chunk)
        while view:
            remaining = MAX_STATE_LINE + 1 - len(buffer)
            part, view = view[:remaining], view[remaining:]
            buffer.extend(part)
            while b"\n" in buffer:
                line, _, rest = buffer.partition(b"\n")
                buffer = bytearray(rest)
                if len(line) > MAX_STATE_LINE:
                    raise NativeStateProtocolError("The native-state frame exceeds its supported size")
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except (UnicodeError, json.JSONDecodeError):
                    raise NativeStateProtocolError("The native-state stream contains an invalid frame") from None
                if not isinstance(value, dict):
                    raise NativeStateProtocolError("The native-state stream contains an invalid frame")
                yield value
            if len(buffer) > MAX_STATE_LINE:
                raise NativeStateProtocolError("The native-state frame exceeds its supported size")
    if buffer.strip():
        raise NativeStateProtocolError("The native-state stream ended with an incomplete frame")


@dataclass
class NativeStateExport:
    header: dict[str, Any]
    frames: AsyncIterator[dict[str, Any]]
    complete: dict[str, Any] | None = None

    async def chunks(self) -> AsyncIterator[bytes]:
        digest = hashlib.sha256()
        size = 0
        async for frame in self.frames:
            if self.complete is not None:
                raise NativeStateProtocolError("The native-state stream continued after completion")
            if frame.get("type") == "chunk":
                data = frame.get("data")
                if not isinstance(data, str) or len(data) > 4 * ((MAX_STATE_CHUNK + 2) // 3):
                    raise NativeStateProtocolError("The native-state chunk is invalid")
                try:
                    chunk = base64.b64decode(data, validate=True)
                except (ValueError, binascii.Error):
                    raise NativeStateProtocolError("The native-state chunk is invalid") from None
                size += len(chunk)
                if not chunk or len(chunk) > MAX_STATE_CHUNK or size > MAX_STATE_BYTES or size > self.header["bytes"]:
                    raise NativeStateProtocolError("The native-state archive exceeds its declared size")
                digest.update(chunk)
                yield chunk
            elif frame.get("type") == "complete":
                for key in ("checkpoint_id", "format", "archive", "profile_id", "profile_revision", "harness", "provider_session_id", "cwd", "sha256", "bytes", "runtime_versions"):
                    if frame.get(key) != self.header.get(key):
                        raise NativeStateProtocolError("The native-state completion descriptor changed")
                if (frame.get("bytes") != size or frame.get("sha256") != digest.hexdigest()
                        or not _integer(frame.get("members"), MAX_STATE_MEMBERS)
                        or not _integer(frame.get("expanded_bytes"), MAX_STATE_BYTES)):
                    raise NativeStateProtocolError("The native-state archive failed integrity verification")
                self.complete = dict(frame)
            else:
                raise NativeStateProtocolError("The native-state stream has an unexpected frame")
        if self.complete is None:
            raise NativeStateProtocolError("The native-state archive was not completed")


def state_line(frame: dict[str, Any]) -> bytes:
    raw = json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"
    if len(raw) - 1 > MAX_STATE_LINE:
        raise NativeStateProtocolError("The native-state frame exceeds its supported size")
    return raw
