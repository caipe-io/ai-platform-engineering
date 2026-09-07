# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Turn Slack file attachments into multimodal chat input.

When a user attaches files to a Slack message, the event carries a ``files``
array where each entry has a **private** download URL (``url_private`` /
``url_private_download``) plus metadata (``mimetype``, ``name``, ``size``).
Slack will only serve those bytes to a request that presents the bot token as
``Authorization: Bearer <token>`` — an unauthenticated fetch returns an HTML
login page, not the file.

This module downloads those bytes and base64-encodes them into the dict shape
the Dynamic Agents backend expects for ``ChatRequest.files`` (see the
``InputFile`` model): ``{"mime_type", "data", "name"}``. The backend's
``_build_user_content`` then maps each MIME type to the correct multimodal
content block (image vs document) and skips types Bedrock cannot ingest — so
this module is deliberately **type-agnostic**: it downloads whatever the user
attached and lets the backend decide what is usable.

The one transform that MUST happen here is url → base64: Bedrock's Converse API
accepts image/document data only as inline base64, never as a URL it fetches
itself. Since Slack's URLs are private (auth-gated) anyway, the model could not
reach them even if Bedrock allowed URLs.
"""

from __future__ import annotations

import base64
import logging
import os
from typing import Any, Mapping, NamedTuple, Optional, Sequence

import requests

logger = logging.getLogger("caipe.slack_bot.file_ingest")


class IngestResult(NamedTuple):
    """Outcome of ingesting a message's Slack attachments.

    ``files`` are the usable attachments (``{"mime_type", "data", "name"}``
    dicts) to send to the model. ``notices`` are human-readable strings for
    files that were attached but could **not** be made available — e.g. the
    bot lacks the ``files:read`` scope so Slack served a login page instead of
    the bytes. Callers append these to the message so the agent can tell the
    user a file was attached but unreadable, rather than silently ignoring it.
    Benign skips (files over the size cap) do not produce a notice.
    """

    files: list[dict[str, Any]]
    notices: list[str]

# Cap on a single file's raw (pre-base64) size. base64 inflates bytes ~33%, and
# every attached file rides inline in one LLM request, so an unbounded upload
# could blow the request size / cost. 20 MiB is comfortably above typical
# screenshots and PDFs while bounding worst case.
DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024

# Total cap across all files on one message, for the same reason.
DEFAULT_MAX_TOTAL_BYTES = 40 * 1024 * 1024

_DOWNLOAD_TIMEOUT_SECONDS = 30


def _resolve_bot_token(explicit: Optional[str]) -> Optional[str]:
    """Return the Slack bot token to authenticate file downloads.

    Precedence: an explicit token (e.g. the handler's ``client.token``), then
    the same env vars the Bolt app itself uses. Returns ``None`` when no token
    is available so the caller can skip ingestion rather than fire an
    unauthenticated request that would download a login page.
    """
    return (
        explicit
        or os.environ.get("SLACK_INTEGRATION_BOT_TOKEN")
        or os.environ.get("SLACK_BOT_TOKEN")
        or None
    )


def _download_one(url: str, token: str) -> tuple[bytes, Optional[str]]:
    """Fetch a single Slack private file URL with bot-token auth.

    Returns ``(content_bytes, content_type_header)``. Raises for any non-2xx
    response so the caller can skip that file. Slack serves an HTML login page
    (HTTP 200) for missing/invalid auth, so ``raise_for_status`` alone is not
    enough — the caller MUST also sanity-check the returned content type / bytes
    (see ``_looks_like_html_login`` / ``_sniff_ok``).
    """
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {token}"},
        timeout=_DOWNLOAD_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    content_type = None
    headers = getattr(resp, "headers", None)
    if headers is not None:
        content_type = headers.get("Content-Type")
    return resp.content, content_type


# Magic-byte signatures for the binary types Bedrock ingests. Used to catch the
# Slack "HTML login page served as HTTP 200" failure — and any other
# content/declared-type mismatch — before forwarding bad bytes to the model,
# which would otherwise surface as a confusing provider-side error
# (e.g. Azure OpenAI ``invalid_image_format``).
_MAGIC_SIGNATURES: dict[str, tuple[bytes, ...]] = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    # image/webp is RIFF....WEBP — validated specially in _sniff_ok.
    "application/pdf": (b"%PDF-",),
}


def _looks_like_html_login(
    data: bytes, content_type: Optional[str], mime_type: str
) -> bool:
    """True if the bytes look like Slack's HTML login page, not the real file.

    Slack returns that page with HTTP 200 (so ``raise_for_status`` passes) when
    the bot token lacks the ``files:read`` scope. Detect it two ways: the
    response ``Content-Type`` says HTML, or — when that header is absent/generic
    — the body of a declared *binary* type begins with an HTML tag (a real
    image/PDF never does; text uploads are left to the header check to avoid
    false-positives on files that legitimately contain HTML source).
    """
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in ("text/html", "application/xhtml+xml") and not mime_type.startswith(
        "text/html"
    ):
        return True
    if mime_type.startswith("image/") or mime_type == "application/pdf":
        head = data[:512].lstrip().lower()
        if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
            return True
    return False


def _sniff_ok(data: bytes, mime_type: str) -> bool:
    """True if ``data``'s leading bytes match the declared ``mime_type``.

    Only the binary types in ``_MAGIC_SIGNATURES`` are checked; types without a
    reliable signature (text/*, Office XML, etc.) always pass — the
    ``_looks_like_html_login`` check is the backstop for those.
    """
    if mime_type == "image/webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    sigs = _MAGIC_SIGNATURES.get(mime_type)
    if not sigs:
        return True
    return any(data.startswith(sig) for sig in sigs)


def _inaccessible_notice(name: Optional[str], *, scope_hint: bool = False) -> str:
    """User-facing string for a file that was attached but couldn't be read.

    ``scope_hint`` adds the likely cause (missing ``files:read`` scope) for the
    HTML-login-page case, which is the most common and most actionable one, plus
    a pointer to upload the file in the Forge UI instead — the reliable fallback
    when Slack file access isn't available.
    """
    label = f"'{name}'" if name else "A file"
    if scope_hint:
        return (
            f"{label} was attached but couldn't be accessed — the Slack bot is "
            f"likely missing the 'files:read' permission, so I can't read it. "
            f"You can upload the file directly in the Forge UI instead, where "
            f"file access works."
        )
    return f"{label} was attached but couldn't be accessed, so I can't read it."


def download_slack_files(
    files: Optional[Sequence[Mapping[str, Any]]],
    *,
    bot_token: Optional[str] = None,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
) -> IngestResult:
    """Download Slack attachments into ``ChatRequest.files`` dicts.

    Args:
        files: The ``event["files"]`` array (or ``None``). Each entry is a
            Slack file object with ``url_private_download`` / ``url_private``,
            ``mimetype``, ``name``, and ``size``.
        bot_token: Slack bot token for the ``Authorization`` header. When
            omitted, resolved from the standard bot-token env vars.
        max_file_bytes: Skip any single file larger than this (raw bytes).
        max_total_bytes: Stop once the cumulative raw size would exceed this.

    Returns:
        An ``IngestResult(files, notices)``. ``files`` are
        ``{"mime_type", "data" (base64), "name"}`` dicts in input order,
        omitting any file that could not be made available. ``notices`` are
        user-facing strings for files that were attached but **inaccessible**
        (no bot token, missing url/mime, download failure, or an HTML login
        page from a missing ``files:read`` scope) so the agent can tell the
        user rather than silently dropping them. Files skipped only for size
        do not add a notice.
    """
    if not files:
        return IngestResult([], [])

    token = _resolve_bot_token(bot_token)
    if not token:
        logger.warning(
            "[file_ingest] Slack attachments present but no bot token available; "
            "skipping %d file(s) — the model will not see them",
            len(files),
        )
        return IngestResult(
            [],
            [
                "One or more files were attached but couldn't be accessed "
                "(the Slack bot has no token configured to download them)."
            ],
        )

    out: list[dict[str, Any]] = []
    notices: list[str] = []
    total = 0
    for f in files:
        name = f.get("name")
        mime_type = f.get("mimetype")
        # url_private_download forces an attachment response; fall back to
        # url_private (inline) when the download variant is absent.
        url = f.get("url_private_download") or f.get("url_private")

        if not url or not mime_type:
            logger.warning(
                "[file_ingest] Skipping attachment (name=%r): missing url or mimetype",
                name,
            )
            notices.append(_inaccessible_notice(name))
            continue

        # Trust Slack's declared size for a cheap pre-download guard; re-check
        # the actual byte count after download in case it is absent/wrong.
        declared = f.get("size")
        if isinstance(declared, int) and declared > max_file_bytes:
            logger.warning(
                "[file_ingest] Skipping %r: declared size %d exceeds per-file cap %d",
                name, declared, max_file_bytes,
            )
            continue

        try:
            data, content_type = _download_one(url, token)
        except Exception as exc:  # noqa: BLE001 — one bad file shouldn't sink the turn
            logger.warning(
                "[file_ingest] Failed to download %r: %s", name, exc
            )
            notices.append(_inaccessible_notice(name))
            continue

        # Defense-in-depth: Slack returns an HTML login page (HTTP 200) when the
        # bot token lacks the files:read scope. Forwarding those bytes under the
        # declared mime_type makes the model provider raise a confusing
        # invalid_image_format error, so skip+warn on any content/type mismatch.
        if _looks_like_html_login(data, content_type, mime_type):
            logger.warning(
                "[file_ingest] Skipping %r: response looks like an HTML login "
                "page, not %s — check the bot token has the files:read scope",
                name, mime_type,
            )
            notices.append(_inaccessible_notice(name, scope_hint=True))
            continue

        if not _sniff_ok(data, mime_type):
            logger.warning(
                "[file_ingest] Skipping %r: content does not match declared "
                "type %s (Content-Type=%r) — not forwarding bad bytes to the model",
                name, mime_type, content_type,
            )
            notices.append(_inaccessible_notice(name))
            continue

        if len(data) > max_file_bytes:
            logger.warning(
                "[file_ingest] Skipping %r: downloaded size %d exceeds per-file cap %d",
                name, len(data), max_file_bytes,
            )
            continue

        if total + len(data) > max_total_bytes:
            logger.warning(
                "[file_ingest] Stopping ingestion at %r: total size would exceed cap %d",
                name, max_total_bytes,
            )
            break

        total += len(data)
        out.append(
            {
                "mime_type": mime_type,
                "data": base64.b64encode(data).decode("ascii"),
                "name": name,
            }
        )

    if out:
        logger.info("[file_ingest] Prepared %d/%d attachment(s) for the model", len(out), len(files))
    return IngestResult(out, notices)
