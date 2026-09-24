"""
Batch loader for CAIPE eval results.

Matches the actual output of aggregateresult.py: a single combined
CSV/JSON per batch (e.g. results/batch_combined_results.csv), containing
every config's rows stacked together and tagged with batch_id, run_id,
and config_name.

Config parameters differ between sweep scripts (run_batch.py uses
max_context_chars + answer_mode, run_batch_topk.py uses top_k +
max_context_chars). Rather than guessing which columns are config vs. data,
this loader uses an explicit list (KNOWN_CONFIG_COLS below): named columns
go to a run's config_json, everything else is treated as per-question eval
data and stored as JSONB. (An earlier version tried to infer this from
"is this column constant within a run" — that broke when a metric score
happened to be constant by chance across a small run, silently losing it
as eval data. Explicit list avoids that.)

Usage (read-after-complete, run once aggregateresult.py has finished):
    python load_results.py --combined-csv results/batch_combined_results.csv
"""

import argparse
import json
import os

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

# Columns that identify a row rather than describe a run's config or data
ID_COLS = {"batch_id", "run_id", "config_name", "source_file"}

# Known sweep-parameter columns, from run_batch.py / run_batch_topk.py's
# config dicts. Add new parameter names here if a teammate adds another
# sweep script — do NOT infer these from value uniqueness (a metric score
# can easily be constant across a small run by chance, e.g. --max-items 14,
# and that would silently get miscategorized as config instead of data).
KNOWN_CONFIG_COLS = {"max_context_chars", "answer_mode_param", "top_k"}


def get_conn():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        port=os.environ.get("PGPORT", "5432"),
        dbname=os.environ.get("PGDATABASE", "evaluator"),
        user=os.environ.get("PGUSER", "evaluator"),
        password=os.environ.get("PGPASSWORD", ""),
        # Supabase (and most hosted Postgres) requires SSL; local Docker
        # Postgres doesn't need it but accepts "prefer" fine either way.
        sslmode=os.environ.get("PGSSLMODE", "prefer"),
    )


def _native(v):
    """Convert numpy/pandas scalars to native Python types so numeric values
    stay numeric in JSONB instead of being stringified by json.dumps'
    default=str fallback."""
    if pd.isna(v):
        return None
    if hasattr(v, "item"):
        return v.item()
    return v


def split_config_and_data_cols(group: pd.DataFrame):
    """Deterministic split: known parameter columns -> config, everything
    else -> per-question eval data. Not based on value uniqueness (see
    KNOWN_CONFIG_COLS comment for why)."""
    cols = [c for c in group.columns if c not in ID_COLS]
    config_cols = [c for c in cols if c in KNOWN_CONFIG_COLS]
    data_cols = [c for c in cols if c not in KNOWN_CONFIG_COLS]
    return config_cols, data_cols


def load_combined(conn, combined_csv_path):
    df = pd.read_csv(combined_csv_path)
    for required in ("batch_id", "run_id", "config_name"):
        if required not in df.columns:
            raise SystemExit(f"combined CSV is missing required column: {required}")

    cur = conn.cursor()
    total_rows = 0

    for run_id, group in df.groupby("run_id", sort=False):
        batch_id = group["batch_id"].iloc[0]
        config_name = group["config_name"].iloc[0]
        config_cols, data_cols = split_config_and_data_cols(group)
        config_json = {c: _native(group[c].iloc[0]) for c in config_cols}

        cur.execute(
            """
            INSERT INTO batches (batch_id)
            VALUES (%s)
            ON CONFLICT (batch_id) DO NOTHING
            """,
            (batch_id,),
        )

        cur.execute(
            """
            INSERT INTO runs (run_id, batch_id, config_name, config_json)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (run_id) DO UPDATE
                SET config_json = EXCLUDED.config_json,
                    loaded_at   = now()
            """,
            (run_id, batch_id, config_name, json.dumps(config_json, default=str)),
        )

        # replace any prior load of this run before re-inserting (idempotent)
        cur.execute("DELETE FROM eval_results WHERE run_id = %s", (run_id,))

        rows = [
            (
                run_id,
                batch_id,
                r.get("question"),
                json.dumps({c: _native(r.get(c)) for c in data_cols}, default=str),
            )
            for r in group.to_dict("records")
        ]
        execute_values(
            cur,
            """
            INSERT INTO eval_results (run_id, batch_id, question, row_data)
            VALUES %s
            """,
            rows,
            template="(%s, %s, %s, %s::jsonb)",
        )
        total_rows += len(rows)
        print(
            f"Loaded run '{run_id}' (config: {config_name}) — {len(rows)} rows, "
            f"config params: {list(config_json.keys())}"
        )

    conn.commit()
    print(f"\nDone — {total_rows} total rows across {df['run_id'].nunique()} runs.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--combined-csv",
        required=True,
        help="Path to batch_combined_results.csv from aggregateresult.py",
    )
    args = p.parse_args()

    conn = get_conn()
    load_combined(conn, args.combined_csv)
    conn.close()


if __name__ == "__main__":
    main()
