from __future__ import annotations

import json
from pathlib import Path

import requests


def sanitize_path(path_val: str | None) -> str | None:
    """Sanitize file paths to prevent internal host OS directory leakage in API and result outputs."""
    if not path_val or not isinstance(path_val, str):
        return path_val
    clean_path = path_val.rstrip("/\\")
    return Path(clean_path).name if clean_path else path_val


def download_text(url: str, cache_path: Path, timeout: int = 60) -> str:
    if cache_path.exists():
        return cache_path.read_text(encoding="utf-8")
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    cache_path.write_text(resp.text, encoding="utf-8")
    return resp.text


def download_bytes(url: str, cache_path: Path, timeout: int = 180) -> bytes:
    if cache_path.exists():
        return cache_path.read_bytes()
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    cache_path.write_bytes(resp.content)
    return resp.content


# Evaluation uses generated JSONL question files so ingestion and scoring stay
# connected to the same sampled corpus.
def load_eval_questions(
    path: Path,
    max_items: int | None,
    limit_per_category: int | None = None,
    combine_with_level: bool = False,
) -> list[dict]:
    rows: list[dict] = []
    category_counts: dict[tuple[str, str | None] | str, int] = {}
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            item = json.loads(line)
            cat = item.get("category", "basic") or "basic"
            if limit_per_category is not None:
                key = (cat, item.get("level")) if combine_with_level else cat
                count = category_counts.get(key, 0)
                if count >= limit_per_category:
                    continue
                category_counts[key] = count + 1
            rows.append(item)
            if max_items and len(rows) >= max_items:
                break
    return rows


def parse_indices(indices_str: str, max_len: int) -> set[int]:
    """Parse string representation of indices (e.g., '1,2,5-8') into a set of 1-based indices."""
    indices = set()
    for part in indices_str.split(","):
        part = part.strip()
        if "-" in part:
            try:
                start_str, end_str = part.split("-", 1)
                start = max(1, int(start_str.strip()))
                end = min(max_len, int(end_str.strip()))
                if start <= end:
                    for i in range(start, end + 1):
                        indices.add(i)
            except ValueError:
                pass
        else:
            try:
                i = int(part)
                if 1 <= i <= max_len:
                    indices.add(i)
            except ValueError:
                pass
    return indices
