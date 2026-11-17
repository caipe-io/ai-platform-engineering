"""Deterministic ACP subprocess for transport and lifecycle tests; no model calls."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def send(value: dict[str, Any]) -> None:
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


def main() -> None:
    waiting_id: int | None = None
    for line in sys.stdin:
        rpc = json.loads(line)
        method, params = rpc["method"], rpc.get("params", {})
        result: dict[str, Any] = {}
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}, "authMethods": []}
        elif method == "session/new":
            Path("session.json").write_text(json.dumps(params))
            Path("provider-environment.json").write_text(json.dumps({
                key: os.environ.get(key) for key in (
                    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
                    "AWS_EC2_METADATA_DISABLED", "HARNESS_ENGINE_INTERNAL_TOKEN",
                )
            }))
            Path("tool-limits.json").write_text(
                json.dumps(
                    {
                        key: os.environ.get(key)
                        for key in (
                            "MCP_TOOL_TIMEOUT",
                            "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT",
                            "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS",
                        )
                    }
                )
            )
            result = {"sessionId": "session-example"}
        elif method == "session/load":
            assert Path("session.json").exists()
            send(
                {
                    "method": "session/update",
                    "params": {
                        "sessionId": params["sessionId"],
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "old replay"},
                        },
                    },
                }
            )
        elif method == "session/prompt":
            if params["prompt"][0]["text"] == "spawn-child":
                child = subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        'import time; from pathlib import Path; time.sleep(0.6); Path("orphan-write").touch()',
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                Path("child.pid").write_text(str(child.pid))
            if params["prompt"][0]["text"] == "wait":
                waiting_id = rpc["id"]
                continue
            send(
                {
                    "method": "session/update",
                    "params": {
                        "sessionId": params["sessionId"],
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "new response"},
                        },
                    },
                }
            )
            result = {"stopReason": "end_turn"}
        elif method == "session/cancel":
            Path("cancelled").touch()
            send({"id": waiting_id, "result": {"stopReason": "cancelled"}})
            return
        send({"id": rpc["id"], "result": result})


if __name__ == "__main__":
    main()
