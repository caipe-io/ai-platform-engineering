"""OpenAI-compatible mock provider for gateway conformance runs.

The requested model selects the behavior:
- ``mock-chat``: a fixed completion, streamed when requested, or a tool call when tools are offered.
- ``mock-429`` / ``mock-500`` / ``mock-402-quota``: an upstream error of that class.
"""

import json
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()

ERRORS: dict[str, tuple[int, str, str]] = {
    "mock-429": (429, "rate_limit_exceeded", "Upstream rate limit reached."),
    "mock-500": (500, "server_error", "Upstream internal error."),
    "mock-402-quota": (402, "insufficient_quota", "Upstream quota exhausted for this budget."),
}
REPLY = "conformance-ok"


def _completion(model: str, message: dict[str, Any], finish: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
    }


def _stream(model: str):
    for chunk in (REPLY[:11], REPLY[11:]):
        delta = {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
                 "choices": [{"index": 0, "delta": {"role": "assistant", "content": chunk}, "finish_reason": None}]}
        yield f"data: {json.dumps(delta)}\n\n"
    done = {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}}
    yield f"data: {json.dumps(done)}\n\n"
    yield "data: [DONE]\n\n"


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    model = str(body.get("model", ""))
    if model in ERRORS:
        status, code, message = ERRORS[model]
        return JSONResponse({"error": {"message": message, "type": code, "code": code}}, status_code=status)
    if body.get("tools"):
        name = body["tools"][0]["function"]["name"]
        call = {"id": "call_mock", "type": "function", "function": {"name": name, "arguments": "{}"}}
        return _completion(model, {"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls")
    if body.get("stream"):
        return StreamingResponse(_stream(model), media_type="text/event-stream")
    return _completion(model, {"role": "assistant", "content": REPLY}, "stop")


@app.get("/v1/models")
async def models():
    names = ["mock-chat", *ERRORS]
    return {"object": "list", "data": [{"id": n, "object": "model", "owned_by": "mock"} for n in names]}
