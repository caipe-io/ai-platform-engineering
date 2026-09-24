#!/usr/bin/env python3
"""Fail when a vendored copy has drifted from its canonical source.

`ai_platform_engineering/llm_wrapper/` is canonical source that consumers copy
rather than install, so each consumer can pin its own provider integrations.
The cost of copying is drift, and here drift is a correctness risk rather than
untidiness: a `resolve_bedrock_client` that classifies a model id differently in
two copies produces different prompt caching and attachment shaping for the same
model -- a bug that reproduces in one service and not the other.

Declared divergence is fine. Silent divergence is what this catches.

Usage:
    python scripts/check_vendored.py           # verify, exit 1 on drift
    python scripts/check_vendored.py --fix     # re-copy canonical over the copies
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG = REPO_ROOT / "vendored.toml"


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_config() -> dict:
    if not CONFIG.exists():
        print(f"error: {CONFIG.relative_to(REPO_ROOT)} not found", file=sys.stderr)
        raise SystemExit(2)
    return tomllib.loads(CONFIG.read_text())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fix",
        action="store_true",
        help="re-copy canonical over each vendored copy instead of reporting",
    )
    args = parser.parse_args()

    config = _load_config()
    divergences = {
        d["path"]: d.get("reason", "<no reason given>")
        for d in config.get("divergence", [])
    }

    problems: list[str] = []
    fixed: list[str] = []
    checked = 0

    for entry in config.get("vendor", []):
        source_dir = REPO_ROOT / entry["source"]
        target_dir = REPO_ROOT / entry["target"]
        for filename in entry["files"]:
            source = source_dir / filename
            target = target_dir / filename
            rel_target = str(target.relative_to(REPO_ROOT))

            if not source.exists():
                problems.append(f"missing canonical source: {entry['source']}/{filename}")
                continue

            if rel_target in divergences:
                checked += 1
                continue

            if not target.exists():
                if args.fix:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                    fixed.append(rel_target)
                else:
                    problems.append(f"missing vendored copy: {rel_target}")
                continue

            checked += 1
            if _digest(source) != _digest(target):
                if args.fix:
                    shutil.copy2(source, target)
                    fixed.append(rel_target)
                else:
                    problems.append(
                        f"drifted from canonical: {rel_target}\n"
                        f"    canonical: {entry['source']}/{filename}\n"
                        f"    re-copy it, or declare the divergence in vendored.toml"
                    )

    if fixed:
        for path in fixed:
            print(f"updated {path}")
        return 0

    if problems:
        print("Vendored copies are out of sync with canonical source:\n", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "\nRun `python scripts/check_vendored.py --fix` to re-copy, then commit "
            "canonical and the copies together.",
            file=sys.stderr,
        )
        return 1

    declared = f", {len(divergences)} declared divergence(s)" if divergences else ""
    print(f"ok: {checked} vendored file(s) match canonical{declared}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
