import json
from datetime import datetime
from pathlib import Path

import pandas as pd

# Locate repo root relative to this script's location (works regardless of cwd)
REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIGS_FILE = Path(__file__).resolve().parent / "batch_configs.json"
RESULTS_DIR = REPO_ROOT / "results"

# Load the parameter configs used for this batch run
configs = json.load(open(CONFIGS_FILE))

# Auto-detect the most recently written result CSVs (one per config),

csv_files = sorted(
    RESULTS_DIR.glob("precomputed_deepeval_*.csv"), key=lambda p: p.stat().st_mtime
)[-len(configs) :]

# One shared batch_id for this whole aggregation run (groups all configs together)
batch_id = datetime.now().strftime("%Y%m%d-%H%M%S")

all_dfs = []
for cfg, csv_file in zip(configs, csv_files):
    df = pd.read_csv(csv_file)

    # Tag every row with which config produced it
    df["config_name"] = cfg["name"]
    df["max_context_chars"] = cfg["max_context_chars"]
    df["answer_mode_param"] = cfg["answer_mode"]
    df["source_file"] = csv_file.name

    # Unique identifiers for DB integration
    df["batch_id"] = batch_id
    df["run_id"] = f"{batch_id}_{cfg['name']}"

    all_dfs.append(df)

combined = pd.concat(all_dfs, ignore_index=True)


combined.to_csv(RESULTS_DIR / "batch_combined_results.csv", index=False)
combined.to_json(
    RESULTS_DIR / "batch_combined_results.json", orient="records", indent=2
)

print(f"Batch ID: {batch_id}")
print(f"Combined {len(combined)} rows from {len(configs)} configs")
print(f"Wrote: {RESULTS_DIR}/batch_combined_results.csv and .json")
