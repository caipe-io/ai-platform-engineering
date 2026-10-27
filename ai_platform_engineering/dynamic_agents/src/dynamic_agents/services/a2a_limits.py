"""Bound remote A2A responses before the SDK buffers or parses their contents."""

from collections.abc import AsyncIterator

import httpx

DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024


class A2AResponseLimitError(RuntimeError):
    """An A2A response exceeds its invocation's permitted resource budget."""


class _BoundedResponseStream(httpx.AsyncByteStream):
    def __init__(self, response: httpx.Response, budget: "A2ABoundedTransport") -> None:
        self.response = response
        self.budget = budget

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self.response.aiter_raw():
                self.budget.received_bytes += len(chunk)
                if self.budget.received_bytes > self.budget.max_response_bytes:
                    raise A2AResponseLimitError(
                        f"Remote A2A responses exceeded {self.budget.max_response_bytes} bytes"
                    )
                yield chunk
        finally:
            await self.response.aclose()

    async def aclose(self) -> None:
        await self.response.aclose()


class A2ABoundedTransport(httpx.AsyncBaseTransport):
    """Share a byte budget across discovery and execution in one invocation.

    Identity encoding lets us enforce the budget before deserialization without
    permitting compressed responses to expand beyond it. Count all bytes,
    including non-text parts, SSE comments, and metadata.
    """

    def __init__(self, max_response_bytes: int, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.max_response_bytes = max_response_bytes
        self.received_bytes = 0
        self.transport = transport or httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        request.headers["Accept-Encoding"] = "identity"
        response = await self.transport.handle_async_request(request)
        encoding = response.headers.get("Content-Encoding", "identity").strip().lower()
        if encoding not in {"", "identity"}:
            await response.aclose()
            raise A2AResponseLimitError("Remote A2A responses must use identity Content-Encoding")
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            stream=_BoundedResponseStream(response, self),
            extensions=response.extensions,
        )

    async def aclose(self) -> None:
        await self.transport.aclose()
