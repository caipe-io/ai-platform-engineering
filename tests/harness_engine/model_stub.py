"""Deterministic OpenAI transport fixture; execution, checkpoints and tools stay real."""

from __future__ import annotations

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from uuid import uuid4


def reply(body: dict[str, Any]) -> dict[str, Any]:
    messages = body.get("messages", [])
    user_index = max((index for index, message in enumerate(messages) if message["role"] == "user"), default=0)
    user = str(messages[user_index].get("content", ""))
    tools_after = any(message["role"] == "tool" for message in messages[user_index + 1 :])
    if tools_after:
        return {"role": "assistant", "content": "Tool completed. " + str(messages[-1].get("content", ""))}
    name, arguments = None, {}
    if "pause-example" in user:
        name, arguments = (
            "request_user_input",
            {"prompt": "Choose a value", "fields": [{"field_name": "value", "field_type": "text", "required": True}]},
        )
    elif "approval-example" in user:
        name, arguments = "wait", {"seconds": 1}
    elif "file-example" in user:
        name, arguments = "write_file", {"file_path": "/example.txt", "content": "example-file-content"}
    elif "slow-example" in user:
        time.sleep(2)
        name, arguments = "wait", {"seconds": 4}
    elif "child-example" in user:
        name, arguments = "task", {"subagent_type": "general-purpose", "description": "Return the text child-result"}
    if name:
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call-" + uuid4().hex,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(arguments)},
                }
            ],
        }
    history = " | ".join(str(message.get("content", "")) for message in messages if message["role"] == "user")
    return {"role": "assistant", "content": "Example response: " + history}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        message = reply(body)
        identifier = "chatcmpl-" + uuid4().hex
        base = {"id": identifier, "created": int(time.time()), "model": body.get("model", "example-model")}
        self.send_response(200)
        if body.get("stream"):
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            delta = {**message}
            if "tool_calls" in delta:
                delta["tool_calls"] = [{"index": index, **call} for index, call in enumerate(delta["tool_calls"])]
            for payload in [
                {
                    **base,
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                },
                {
                    **base,
                    "object": "chat.completion.chunk",
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "tool_calls" if "tool_calls" in message else "stop"}
                    ],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                },
            ]:
                self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        **base,
                        "object": "chat.completion",
                        "choices": [
                            {
                                "index": 0,
                                "message": message,
                                "finish_reason": "tool_calls" if "tool_calls" in message else "stop",
                            }
                        ],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                    }
                ).encode()
            )

    def log_message(self, format: str, *args: Any) -> None:
        # Neither conversation contents nor authorization headers belong in logs.
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
