"""Read-only latency probe for the statistics audit query; never prints events."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen

MAX_RESPONSE_BYTES = 16 * 1024 * 1024
DASHBOARD_BUDGET_MS = 5_000


def benchmark_read(base_url: str, *, hours: int, timeout: float = 35.0) -> dict[str, Any]:
    """Return status/count/latency metadata for one read, excluding event data."""
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("base URL must be HTTP(S) without embedded credentials")
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ValueError("base URL must identify the service origin without a path, query or fragment")
    if not 1 <= hours <= 31 * 24 or not 0 < timeout <= 120:
        raise ValueError("hours must be 1..744 and timeout must be greater than 0 and at most 120 seconds")
    end = datetime.now(timezone.utc)
    query = urlencode({
        "since": (end - timedelta(hours=hours)).isoformat(),
        "until": end.isoformat(),
        "reason_code": "OK_LOCAL_AGENT_CONTEXT",
        "limit": 10_000,
    })
    result: dict[str, Any] = {"hours": hours}
    started = time.monotonic()
    try:
        with urlopen(f"{base_url.rstrip('/')}/v1/audit/events?{query}", timeout=timeout) as response:
            result["status"] = response.status
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                result["error"] = "response_too_large"
            else:
                payload = json.loads(body)
                if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
                    result["error"] = "invalid_response"
                else:
                    result["records"] = len(payload["records"])
                    total = payload.get("total")
                    result["total"] = total if type(total) is int and total >= 0 else None
                    result["truncated"] = payload.get("truncated") is True
    except HTTPError as error:
        result["status"] = error.code
        result["error"] = "http_error"
        error.close()
    except (TimeoutError, URLError) as error:
        result["error"] = "timeout" if isinstance(error, TimeoutError) or isinstance(error.reason, TimeoutError) else "connection_error"
    except (ValueError, UnicodeError):
        result["error"] = "invalid_response"
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    result["within_dashboard_budget"] = (
        result.get("status") == 200 and "error" not in result
        and result["elapsed_ms"] <= DASHBOARD_BUDGET_MS and not result.get("truncated")
        and result.get("total") is not None and result.get("total") == result.get("records")
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Authorized internal audit service origin")
    parser.add_argument("--hours", type=int, nargs="+", default=[1, 24, 720])
    parser.add_argument("--timeout", type=float, default=35.0)
    args = parser.parse_args()
    if len(args.hours) > 3:
        parser.error("At most three sequential queries are permitted per invocation")
    results = []
    for hours in args.hours:
        result = benchmark_read(args.base_url, hours=hours, timeout=args.timeout)
        print(json.dumps(result), flush=True)
        results.append(result)
    raise SystemExit(0 if all(result["within_dashboard_budget"] for result in results) else 1)


if __name__ == "__main__":
    main()
