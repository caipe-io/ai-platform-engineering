"""Scripted CLI subprocess to exercise stream framing, policy and cancellation."""

from __future__ import annotations

import json
import signal
import sys
import time
from pathlib import Path


def emit(value: dict) -> None:
    print(json.dumps(value), flush=True)


def main() -> None:
    args = sys.argv[1:]
    session = args[args.index("--resume" if "--resume" in args else "--session-id") + 1]
    policy = {"arguments": args, "mcp": json.loads(Path(args[args.index("--mcp-config") + 1]).read_text())}
    Path("cli-policy.json").write_text(json.dumps(policy))
    prompt = sys.stdin.read()
    emit({"type": "system", "subtype": "init", "session_id": session})
    if prompt == "wait":
        def stop(signum: int, frame: object) -> None:
            Path("cli-cancelled").touch()
            sys.exit(0)
        signal.signal(signal.SIGINT, stop)
        Path("cli-started").touch()
        while True:
            time.sleep(0.01)
    if prompt == "missing-result":
        return
    if prompt == "failed-result":
        emit({"type": "result", "subtype": "error_during_execution", "is_error": True, "session_id": session})
        return
    emit({"type": "stream_event", "session_id": session, "event": {"delta": {"type": "text_delta", "text": "CLI answer"}}})
    emit({"type": "assistant", "session_id": session, "message": {"content": [
        {"type": "text", "text": "CLI answer"},
        {"type": "tool_use", "id": "tool-example", "name": "mcp__caipe__example_wait", "input": {"seconds": 1}},
    ]}})
    emit({"type": "user", "session_id": session, "message": {"content": [
        {"type": "tool_result", "tool_use_id": "tool-example", "content": "done"},
    ]}})
    emit({"type": "result", "subtype": "success", "is_error": False, "session_id": session})


if __name__ == "__main__":
    main()
