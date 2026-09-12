"""
Combines the separate per-config CSVs produced by run_batch_topk.py into
one batch_combined_results.csv/.json, same shape as aggregate_results.py
produces for run_batch.py — just adapted to a different filename pattern
and config keys (top_k / max_context_chars instead of max_context_chars /
answer_mode).

run_batch_topk.py itself has no combining step (unlike run_batch.py, which
pairs with aggregate_results.py) — this fills that gap. Run this right
after run_batch_topk.py finishes.
"""

from datetime import datetime
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = REPO_ROOT / "results"

# Must match the configs list in run_batch_topk.py, in the same order
CONFIGS = [
    {"name": "topk3", "top_k": 3, "max_context_chars": 8000},
    {"name": "topk5", "top_k": 5, "max_context_chars": 8000},
    {"name": "topk7", "top_k": 7, "max_context_chars": 8000},
]

# Auto-detect the most recently written result CSVs, one per config,
# in the order they were run (oldest of the recent batch first)
csv_files = sorted(
    RESULTS_DIR.glob("hotpotqa_deepeval_results_*.csv"),
    key=lambda p: p.stat().st_mtime,
)[-len(CONFIGS) :]

if len(csv_files) < len(CONFIGS):
    raise SystemExit(
        f"Expected {len(CONFIGS)} result CSVs, found {len(csv_files)}. "
        "Run run_batch_topk.py first."
    )

batch_id = datetime.now().strftime("%Y%m%d-%H%M%S")
all_dfs = []

for cfg, csv_file in zip(CONFIGS, csv_files):
    df = pd.read_csv(csv_file)
    df["config_name"] = cfg["name"]
    df["top_k"] = cfg["top_k"]
    df["max_context_chars"] = cfg["max_context_chars"]
    df["source_file"] = csv_file.name
    df["batch_id"] = batch_id
    df["run_id"] = f"{batch_id}_{cfg['name']}"
    all_dfs.append(df)

combined = pd.concat(all_dfs, ignore_index=True)
combined.to_csv(RESULTS_DIR / "batch_combined_results_topk.csv", index=False)
combined.to_json(
    RESULTS_DIR / "batch_combined_results_topk.json", orient="records", indent=2
)

print(f"Batch ID: {batch_id}")
print(f"Combined {len(combined)} rows from {len(CONFIGS)} configs")
print(f"Matched files (oldest to newest): {[f.name for f in csv_files]}")
print(f"Wrote: {RESULTS_DIR}/batch_combined_results_topk.csv and .json")
