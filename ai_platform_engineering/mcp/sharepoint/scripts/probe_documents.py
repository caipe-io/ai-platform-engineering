# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Read-only real-document probe. Requires the TOME package on PYTHONPATH.

Starts an authenticated loopback-only MCP HTTP server, then exercises TOME's
real streaming/preparation client. Never invokes an LLM, edits a wiki, or logs
credentials/document bodies. Only newly created probe artifacts are written.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import secrets
import socket
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import uvicorn
from mcp_agent_auth import middleware as auth
from starlette.middleware import Middleware
from tome_agent.agent.sharepoint_documents import SharePointDocumentRef, SharePointPreparationError, SharePointPreparer

from api import SharePointGraphClient
from models import SharePointConfig
from server import build_server


def config_from_file(path: Path | None) -> SharePointConfig:
    if path is None:
        return SharePointConfig.from_env()
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        match = re.match(r"^\s*(SHAREPOINT_[A-Z_]+)\s*[:=]\s*(.*?)\s*$", line)
        if match:
            key, value = match.groups()
            values[key] = value.strip().strip("\"'`")
    return SharePointConfig(
        tenant_id=values.get("SHAREPOINT_TENANT_ID", ""),
        client_id=values.get("SHAREPOINT_CLIENT_ID", ""),
        client_secret=values.get("SHAREPOINT_CLIENT_SECRET", ""),
        site_url=values.get("SHAREPOINT_SITE_URL", ""),
        request_timeout_seconds=120,
    )


async def files(client: SharePointGraphClient) -> list[dict[str, Any]]:
    site = client._id(await client.get_site_id())
    result: list[dict[str, Any]] = []
    pending: list[tuple[str, dict[str, Any]]] = [(f"/sites/{site}/drives", {"$top": 100, "$select": "id,name"})]
    drives: list[dict[str, Any]] = []
    while pending:
        path, params = pending.pop()
        payload = await client._request_json(path, params=params)
        drives.extend(payload.get("value", []))
        if link := payload.get("@odata.nextLink"):
            parsed = urlsplit(link)
            if parsed.scheme != "https" or parsed.netloc != "graph.microsoft.com" or not parsed.path.startswith("/v1.0/sites/"):
                raise RuntimeError("Invalid library continuation")
            pending.append((parsed.path.removeprefix("/v1.0"), dict(parse_qsl(parsed.query))))
    for drive in drives:
        path = f"/drives/{client._id(drive['id'])}/root/delta"
        params = {"$top": 200, "$select": "id,name,size,file,folder,deleted,remoteItem"}
        seen: set[str] = set()
        entries: dict[str, dict[str, Any]] = {}
        while True:
            payload = await client._request_json(path, params=params)
            for row in payload.get("value", []):
                if "deleted" in row:
                    entries.pop(row["id"], None)
                else:
                    entries[row["id"]] = row
            link = payload.get("@odata.nextLink")
            if not link:
                break
            parsed = urlsplit(link)
            if (
                link in seen
                or parsed.scheme != "https"
                or parsed.netloc != "graph.microsoft.com"
                or not parsed.path.startswith("/v1.0/drives/")
            ):
                raise RuntimeError("Invalid item continuation")
            seen.add(link)
            path = parsed.path.removeprefix("/v1.0")
            params = dict(parse_qsl(parsed.query))
        result.extend({**row, "drive_id": drive["id"]} for row in entries.values() if "file" in row and "remoteItem" not in row)
    return result


def choose_samples(rows: list[dict[str, Any]], include_largest: bool) -> list[tuple[str, dict[str, Any]]]:
    decks = sorted((row for row in rows if row["name"].lower().endswith(".pptx")), key=lambda row: row.get("size", 0))
    pdfs = sorted((row for row in rows if row["name"].lower().endswith(".pdf")), key=lambda row: row.get("size", 0))
    selected: list[tuple[str, dict[str, Any]]] = []
    if decks:
        for label, target in [("small-pptx", 1_000_000), ("over-10mb-pptx", 12_000_000), ("larger-pptx", 50_000_000)]:
            selected.append((label, min(decks, key=lambda row: abs(row.get("size", 0) - target))))
        if include_largest:
            selected.append(("largest-pptx", decks[-1]))
    if pdfs:
        selected.append(("small-pdf", min(pdfs, key=lambda row: abs(row.get("size", 0) - 1_000_000))))
        selected.append(("larger-pdf", min(pdfs, key=lambda row: abs(row.get("size", 0) - 5_000_000))))
    return selected


async def main(args: argparse.Namespace) -> int:
    config = config_from_file(args.credentials_file)
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    graph = SharePointGraphClient(config)
    if args.sample_report:
        samples = [
            (row["sample"], {**row, "id": row["item_id"], "size": row["source_bytes"]})
            for row in json.loads(args.sample_report.read_text())["tests"]
            if not args.sample_label or row["sample"] == args.sample_label
        ]
    else:
        samples = choose_samples(await files(graph), args.include_largest)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(output, 0o700)
    # A throwaway caller key exists only in this process, never on disk.
    auth.MCP_AUTH_MODE = "shared_key"
    auth.MCP_SHARED_KEY = secrets.token_urlsafe(48)
    app = build_server(config).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    report: dict[str, Any] = {"scanned_at": datetime.now(UTC).isoformat(), "tests": []}
    try:
        for _ in range(200):
            if server.started:
                break
            if task.done():
                await task
                raise RuntimeError("Probe server did not start")
            await asyncio.sleep(0.05)
        if not server.started:
            raise RuntimeError("Probe server startup timed out")
        preparer = SharePointPreparer(
            f"http://127.0.0.1:{listener.getsockname()[1]}",
            auth.MCP_SHARED_KEY,
            output,
            timeout_seconds=900,
            worker_timeout_seconds=180,
            renderer=args.renderer,
            worker_memory_mib=args.memory_mib,
        )
        for label, row in samples:
            started = time.monotonic()
            print(json.dumps({"event": "preparing", "sample": label, "source_bytes": row.get("size")}), flush=True)
            record = {
                "sample": label,
                "name": row["name"],
                "drive_id": row["drive_id"],
                "item_id": row["id"],
                "source_bytes": row.get("size"),
            }
            try:
                ref = SharePointDocumentRef(drive_id=row["drive_id"], item_id=row["id"])
                prepared = await preparer.prepare("document-probe", ref)
                record.update(status="prepared", directory=str(prepared.directory), **prepared.manifest)
                cached = await preparer.prepare("document-probe", ref)
                record["cache_reused"] = cached.cache_hit
            except Exception as exc:
                # Do not print exception text: credential validation failures
                # and library errors can include sensitive input values.
                record.update(status="failed", exception=type(exc).__name__)
                if isinstance(exc, SharePointPreparationError):
                    record["error"] = str(exc)
            record["elapsed_seconds"] = round(time.monotonic() - started, 2)
            report["tests"].append(record)
            (output / "report.json").write_text(json.dumps(report, indent=2))
            print(
                json.dumps(
                    {key: value for key, value in record.items() if key not in {"name", "drive_id", "item_id", "batches", "directory"}}
                ),
                flush=True,
            )
    finally:
        server.should_exit = True
        await task
        listener.close()
    return int(any(row["status"] != "prepared" for row in report["tests"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-file", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="New private output directory; must not already exist")
    parser.add_argument("--include-largest", action="store_true")
    parser.add_argument("--sample-report", type=Path, help="Reuse selection IDs without modifying an earlier probe")
    parser.add_argument("--sample-label", help="Test only this sample label")
    parser.add_argument("--renderer", choices=["graph", "local", "graph_then_local"], default="graph_then_local")
    parser.add_argument("--memory-mib", type=int, default=384, help="Renderer/processor allocation limit")
    parsed_args = parser.parse_args()
    try:
        status = asyncio.run(main(parsed_args))
    except Exception as exc:
        print(json.dumps({"event": "probe_failed", "exception": type(exc).__name__}), file=sys.stderr)
        status = 1
    raise SystemExit(status)
