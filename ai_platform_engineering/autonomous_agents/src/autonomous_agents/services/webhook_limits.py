"""Resource limits applied to public webhook request bodies."""

from __future__ import annotations

from fastapi import HTTPException, Request


def _payload_too_large(max_bytes: int) -> HTTPException:
    return HTTPException(
        status_code=413,
        detail=f"Webhook payload exceeds the {max_bytes}-byte limit.",
    )


async def read_limited_webhook_body(request: Request, *, max_bytes: int) -> bytes:
    """Read a request body without accepting more than ``max_bytes``.

    ``Content-Length`` provides an inexpensive early rejection, while streaming
    and counting enforces the same bound for chunked bodies and dishonest or
    missing length headers.
    """
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail="Content-Length must be a non-negative integer.",
            ) from exc
        if declared_length < 0:
            raise HTTPException(
                status_code=400,
                detail="Content-Length must be a non-negative integer.",
            )
        if declared_length > max_bytes:
            raise _payload_too_large(max_bytes)

    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > max_bytes:
            raise _payload_too_large(max_bytes)
        chunks.append(chunk)
    return b"".join(chunks)
