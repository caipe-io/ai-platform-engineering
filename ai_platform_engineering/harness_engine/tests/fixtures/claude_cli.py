"""Scripted CLI subprocess to exercise stream framing, policy and cancellation."""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from hashlib import sha256
from pathlib import Path


def emit(value: dict) -> None:
    print(json.dumps(value), flush=True)


def main() -> None:
    args = sys.argv[1:]
    session = args[args.index("--resume" if "--resume" in args else "--session-id") + 1]
    policy = {"arguments": args, "mcp": json.loads(Path(args[args.index("--mcp-config") + 1]).read_text())}
    Path("cli-policy.json").write_text(json.dumps(policy))
    prompt = sys.stdin.read()
    if "--effort" in args:
        with Path("research-calls.jsonl").open("a") as calls:
            calls.write(json.dumps(args) + "\n")
    native = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "example" / f"{session}.jsonl"
    if "--resume" in args and not native.exists():
        sys.exit("No conversation found")
    if prompt == "startup-failure":
        sys.exit(1)
    emit({"type": "system", "subtype": "init", "session_id": session})
    if prompt != "wait-before-native":
        native.parent.mkdir(parents=True, exist_ok=True)
        native.write_text(json.dumps({"type": "user", "sessionId": session, "message": {"content": prompt}}) + "\n")
    if prompt in {"wait", "wait-before-native"} or prompt.startswith("research-wait"):
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
    if "--effort" in args:
        def tool(call: str, arguments: dict, output: object, name: str = "mcp__caipe__tool_0", failed: bool = False) -> None:
            emit({"type": "assistant", "session_id": session, "message": {"content": [
                {"type": "tool_use", "id": call, "name": name, "input": arguments}]}})
            emit({"type": "user", "session_id": session, "message": {"content": [
                {"type": "tool_result", "tool_use_id": call, "is_error": failed,
                 "content": [{"type": "text", "text": json.dumps(output)}]}]}})

        # Preserve whether the original task withheld evidence across resumes.
        if "no-evidence" in prompt:
            Path("no-evidence").touch()
        if not Path("no-evidence").exists():
            tool("metadata", {"method": "get", "owner": "example", "repo": "sample", "pullNumber": 1},
                 {"head": {"sha": "a" * 40}, "changed_files": 1})
            tool("files", {"method": "get_files", "owner": "example", "repo": "sample", "pullNumber": 1}, [{"filename": "example.py"}])
            tool("diff", {"method": "get_diff", "owner": "example", "repo": "sample", "pullNumber": 1}, "diff --git a/example.py b/example.py")
        output = {"complete": True, "head_sha": "a" * 40,
                  "coverage": [{"path": "example.py", "status": "reviewed", "evidence": "Pinned source inspected."}],
                  "checks": ["Test source inspected, not executed."], "limitations": ["No test execution."],
                  "report_markdown": "Source-backed review with references and explicit limitations. " * 3}
        if prompt.startswith("research-repair"):
            saved = native.parent / "tool-results" / "pending.json"
            saved.parent.mkdir(exist_ok=True)
            saved.write_text(json.dumps("pending evidence"))
            Path("pending-artifact").write_text(str(saved))
            # A genuine native overflow wrapper is a string, not JSON-quoted text.
            emit({"type": "assistant", "session_id": session, "message": {"content": [
                {"type": "tool_use", "id": "overflow", "name": "mcp__caipe__tool_0", "input": {}}]}})
            emit({"type": "user", "session_id": session, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "overflow", "content": f"<persisted-output>\nFull output saved to: {saved}\nPreview"}]}})
        if "--json-schema" in args and Path("pending-artifact").exists():
            attempted = Path("report-attempted")
            if attempted.exists():
                saved = Path(Path("pending-artifact").read_text())
                raw = saved.read_bytes()
                text = json.loads(raw)
                tool("receipt", {"path": str(saved)}, {"artifact_path": str(saved), "sha256": sha256(raw).hexdigest(),
                     "offset": 0, "end_offset": len(text), "next_offset": None, "total_chars": len(text), "text": text},
                     name="mcp__research__read_artifact")
            attempted.touch()
        if prompt.startswith("research-fallback"):
            Path("formatter-fallback").write_text("denied" if "denied" in prompt else "accepted")
        fallback = "--json-schema" in args and Path("formatter-fallback").exists()
        if fallback:
            tool("formatter", output, "collected", name="StructuredOutput", failed=Path("formatter-fallback").read_text()=="denied")
        emit({"type": "stream_event", "session_id": session, "event": {"delta": {"type": "text_delta", "text": "Unverified draft"}}})
        if prompt.startswith("research-cost-cap"):
            Path("cost-cap").touch()
        capped = prompt.startswith("research-capped")
        cost_capped = "--json-schema" in args and Path("cost-cap").exists()
        emit({"type": "result", "subtype": "error_max_budget_usd" if cost_capped else "error_max_turns" if capped else "success", "is_error": capped or cost_capped, "session_id": session,
              "num_turns": int(args[args.index("--max-turns") + 1]) if capped else 2,
              "total_cost_usd": 0.1, "structured_output": None if fallback else output})
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
