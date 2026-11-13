"""Read-only, paginated access to this workspace's saved MCP output."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


def decoded(value: Any, depth: int = 0) -> str:
    if depth > 6:
        return str(value)
    if isinstance(value, str):
        try:
            return decoded(json.loads(value), depth + 1)
        except ValueError:
            return value
    if isinstance(value, list) and all(isinstance(item, dict) and item.get("type") == "text" for item in value):
        return "\n".join(decoded(item.get("text", ""), depth + 1) for item in value)
    return json.dumps(value, indent=2, ensure_ascii=False)


def read_artifact(root: Path, path: str, offset: int = 0, limit: int = 12000) -> dict[str, Any]:
    if isinstance(offset, bool) or isinstance(limit, bool) or not 0 <= offset or not 1 <= limit <= 12000:
        raise ValueError("Use a nonnegative character offset and a limit from 1 to 12000")
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve(strict=True)
    relative = candidate.relative_to((root / ".claude" / "projects").resolve())
    if "tool-results" not in relative.parts or not candidate.is_file() or candidate.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Only saved tool-result files up to 16 MiB are readable")
    raw = candidate.read_bytes()
    text = decoded(raw.decode("utf-8"))
    if offset > len(text):
        raise ValueError("Offset exceeds artifact length")
    end = min(offset + limit, len(text))
    # Bound escaped JSON too, so this reader's output is not saved as another
    # oversized MCP artifact, including for Unicode and long escaped lines.
    while end > offset + 1 and len(json.dumps(text[offset:end], ensure_ascii=True)) > 8000:
        end = offset + (end - offset) // 2
    return {"artifact_path": str(candidate), "sha256": hashlib.sha256(raw).hexdigest(),
            "offset": offset, "end_offset": end, "next_offset": end if end < len(text) else None,
            "total_chars": len(text), "text": text[offset:end]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    root = Path(parser.parse_args().root).resolve(strict=True)
    server = FastMCP("research")

    @server.tool(name="read_artifact")
    def read(path: str, offset: int = 0, limit: int = 12000) -> dict[str, Any]:
        """Read a saved tool-results artifact, decoding JSON content wrappers. Follow next_offset
        until null to inspect the whole output. Offsets count decoded characters, not lines.
        This cannot read repository files, configuration, credentials, or other workspaces.
        """
        return read_artifact(root, path, offset, limit)

    server.run(transport="stdio")


if __name__ == "__main__":
    main()
