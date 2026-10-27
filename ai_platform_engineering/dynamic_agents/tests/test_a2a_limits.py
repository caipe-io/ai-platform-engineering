"""Transport caps apply before SDK parsing, across discovery and execution."""

from collections.abc import AsyncIterator

import httpx
import pytest

from dynamic_agents.services.a2a_limits import A2ABoundedTransport, A2AResponseLimitError


class _Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.yielded = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            self.yielded += 1
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.parametrize("streaming", [False, True])
async def test_byte_limit_aborts_before_buffering_the_rest(streaming: bool) -> None:
    body = _Chunks([b"1234", b"5678", b"must not read"])
    transport = A2ABoundedTransport(6, httpx.MockTransport(lambda request: httpx.Response(200, stream=body)))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(A2AResponseLimitError, match="responses exceeded 6 bytes"):
            async with client.stream("GET", "https://agent.example.test") as response:
                if streaming:
                    async for _ in response.aiter_bytes():
                        pass
                else:
                    await response.aread()
    assert body.yielded == 2
    assert body.closed


async def test_discovery_and_execution_share_one_budget() -> None:
    bodies = [_Chunks([b"card"]), _Chunks([b"reply"])]
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(200, stream=bodies.pop(0))
    transport = A2ABoundedTransport(8, httpx.MockTransport(respond))
    async with httpx.AsyncClient(transport=transport) as client:
        assert (await client.get("https://agent.example.test/card")).content == b"card"
        with pytest.raises(A2AResponseLimitError):
            await client.post("https://agent.example.test/message")
    assert transport.received_bytes == 9


async def test_exact_wire_budget_is_allowed() -> None:
    body = _Chunks([b"123", b"456"])
    transport = A2ABoundedTransport(6, httpx.MockTransport(lambda request: httpx.Response(200, stream=body)))
    async with httpx.AsyncClient(transport=transport) as client:
        assert (await client.get("https://agent.example.test")).content == b"123456"
    assert body.closed


async def test_compressed_response_is_rejected_without_reading_body() -> None:
    body = _Chunks([b"compressed payload"])
    transport = A2ABoundedTransport(100, httpx.MockTransport(
        lambda request: httpx.Response(200, headers={"Content-Encoding": "gzip"}, stream=body)
    ))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(A2AResponseLimitError, match="identity Content-Encoding"):
            await client.get("https://agent.example.test")
    assert body.closed
    assert body.yielded == 0
