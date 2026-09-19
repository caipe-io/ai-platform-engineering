# CAIPE Eval Results — Batch Pipeline & Database

This documents how DeepEval parameter sweep results flow from a local test
run into a shared, queryable Postgres database. If you're new to this,
read top to bottom; if you just need to run it, jump to **Quick Start**.

## Why this exists

CAIPE's RAG/agent system has tunable parameters (how much context gets
used, how many documents get retrieved, etc.). We don't know in advance
which settings work best, so instead of running DeepEval once, we run it
multiple times — once per config — and compare scores across configs.
That comparison only works if results from different runs are tagged and
stored somewhere queryable, instead of scattered across local CSV files.
That's what this pipeline and database are for.

## The pipeline, end to end

```
1. RUN A SWEEP           →  2. COMBINE THAT SWEEP'S RESULTS  →  3. LOAD INTO DB  →  4. QUERY
   (batch_eval/*.py)         (aggregate_*.py)                    (caipe_eval_db/)     (Supabase)
```

### 1. Run a parameter sweep

Two sweep scripts exist, testing different things:

| Script | Sweeps | Why it's separate |
|---|---|---|
| `batch_eval/run_batch.py` | `max_context_chars`, `answer_mode` | Tests how much retrieved text is used, and whether answers are generated fresh vs. reference-based |
| `batch_eval/run_batch_topk.py` | `top_k` | Tests retrieval quality itself — how many chunks get pulled back *before* any context is even used. Isolated from the above because retrieval and context-usage are different failure points (too few chunks = missed info; too many = noise diluting relevant ones) |

Run whichever sweep you need:
```bash
python batch_eval/run_batch.py
# or
python batch_eval/run_batch_topk.py
```

Each config in the sweep runs DeepEval separately and writes its own
results file (CSV + JSON + summary) to `results/`.

### 2. Combine that sweep's results

Each run writes separate files — the aggregator stitches them into one
file per batch, tagging every row with `config_name`, a shared `batch_id`,
and a `run_id` (`batch_id` + `config_name`) so everything from one sweep
is traceable together.

```bash
python batch_eval/aggregate_results.py        # for run_batch.py output
python batch_eval/aggregate_topk_results.py   # for run_batch_topk.py output
```

> **Known gap:** `run_batch_topk.py` has no built-in aggregator of its own
> (unlike `run_batch.py`, which pairs with `aggregate_results.py`).
> `aggregate_topk_results.py` was written to fill that gap — check with
> whoever owns the batch sweep scripts before assuming it's the permanent
> solution, in case a different one already exists or is planned.

This produces:
- `results/batch_combined_results.csv` / `.json` (context/answer-mode sweep)
- `results/batch_combined_results_topk.csv` / `.json` (top-k sweep)

(Different filenames deliberately, so running both sweeps in the same
session doesn't overwrite one with the other before it's loaded.)

### 3. Load into the database

```bash
python3 caipe_eval_db/load_results.py --combined-csv results/batch_combined_results.csv
python3 caipe_eval_db/load_results.py --combined-csv results/batch_combined_results_topk.csv
```

The loader groups rows by `run_id`, splits columns into config parameters
(`config_json`) vs. per-question eval data (`row_data`), and inserts into
Postgres. It's idempotent — safe to re-run on the same file, it replaces
that run's rows rather than duplicating them.

If you add a new sweep script with a new parameter name (something besides
`max_context_chars`, `answer_mode_param`, `top_k`), add it to
`KNOWN_CONFIG_COLS` at the top of `load_results.py`, or it'll be
(incorrectly) treated as per-question data instead of a config parameter.

### 4. Query it

Once loaded, the data is queryable by anyone with the connection string —
via Supabase's SQL Editor, a script, or a GUI Postgres client. See
**Database Structure** below for the shape, and **Example Queries** for
copy-pasteable starting points.

## Quick Start (already-loaded data — just want to look)

1. Get the connection string (ask a teammate — not committed anywhere)
2. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → project → **SQL Editor**
3. Run:
   ```sql
   SELECT config_name, config_json FROM runs;
   ```
   If that returns rows, you're connected and reading real data.

## Quick Start (running the pipeline yourself)

```bash
# one-time setup
pip install -r requirements.txt   # includes psycopg2-binary, pandas
cp caipe_eval_db/.env.example caipe_eval_db/.env   # fill in real credentials

# every time you run a sweep
python batch_eval/run_batch_topk.py
python batch_eval/aggregate_topk_results.py
export $(cat caipe_eval_db/.env | xargs)
python3 caipe_eval_db/load_results.py --combined-csv results/batch_combined_results_topk.csv
```

## Two ways to run Postgres — which one to use

| | When to use it |
|---|---|
| **Supabase (hosted)** | This is **the real, shared database** the whole team reads from and writes to. Use this for anything meant to be seen by teammates or the UI. |
| **`docker-compose.postgres.yml` (local)** | A local scratch copy, for testing the pipeline on your own machine — e.g. if Supabase's free tier has paused (see Known Limitations) and you don't want to wait on a manual resume, or you're iterating on `load_results.py` and don't want network latency. **Nothing loaded here is visible to teammates.** |

Both use the same `schema.sql`. Point `.env` at whichever one you're using
by setting `PGHOST`/`PGPORT`/etc. accordingly — see `.env.example`.

To start the local option:
```bash
docker compose -f caipe_eval_db/docker-compose.postgres.yml up -d
```

## Database Structure

Hosted on Postgres via Supabase (not local — reachable by the whole team).
Three tables in active use, nested like this:

```
batches          (one row per sweep run)
  └── runs            (one row per config tested, e.g. top_k=5)
        └── eval_results   (one row per question, with all DeepEval scores)
```

A fourth table, `run_summary`, exists in the schema for future aggregate
stats (avg score, p95 latency per run) but nothing populates it yet.

### `batches`
| Column | Meaning |
|---|---|
| `batch_id` | Unique ID for one sweep session (a timestamp) |
| `created_at` | When this batch was recorded |
| `description` | Free-text note, currently unused |

### `runs`
| Column | Meaning |
|---|---|
| `run_id` | Unique ID for one config (`batch_id` + `config_name`) |
| `batch_id` | Which sweep this config belongs to |
| `config_name` | Human-readable config label, e.g. `"topk5"` |
| `config_json` | The actual parameter values used, e.g. `{"top_k": 5, "max_context_chars": 8000}`. Stored as JSON since different sweep types use different parameter names |

### `eval_results`
One row per question. `row_data` holds everything DeepEval measured —
metric scores, the reasoning behind each score, the model's response, and
metadata. Key fields inside `row_data`:

| Field | Meaning |
|---|---|
| `question` / `user_input` | The question asked |
| `response` | The model's actual answer |
| `reference` | The expected/correct answer |
| `faithfulness` | 0–1, is the answer consistent with retrieved context |
| `answer_relevancy` | 0–1, does the answer address the question |
| `contextual_precision` | 0–1, are relevant chunks ranked near the top |
| `contextual_recall` | 0–1, does retrieved context cover what's needed |
| `contextual_relevancy` | 0–1, how much of retrieved context is relevant |
| `retrieval_precision` / `retrieval_recall` | Retrieval-step quality scores |
| `answer_exact_match` / `answer_contains_reference` | 1/0 exact-match checks |
| `<metric>_reason` | Plain-language explanation for each score above |
| `expected_doc_ids` / `retrieved_doc_ids` | Which documents should/did get retrieved |
| `retrieved_contexts` | The actual retrieved text chunks (JSON-encoded string) |
| `failure_cause` | Flag for what went wrong, e.g. `"poor_retrieval"` |
| `latency` | Response time in seconds |
| `total_tokens` | Tokens used for the response |
| `evaluator_*` | Tokens/time used by the judge model to produce the scores |

`config_json` and `row_data` are both JSONB — use `->>'key'` to pull a
value out, and cast (`::float`, `::int`) if doing math on it.

## Example Queries

**Everything for one batch:**
```sql
SELECT r.run_id, r.config_name, r.config_json, e.question, e.row_data
FROM runs r JOIN eval_results e ON e.run_id = r.run_id
WHERE r.batch_id = '20260717-215843';
```

**Compare average faithfulness across configs:**
```sql
SELECT r.config_name, r.config_json,
       AVG((e.row_data->>'faithfulness')::float) AS avg_faithfulness
FROM runs r JOIN eval_results e ON e.run_id = r.run_id
GROUP BY r.config_name, r.config_json;
```

**Pull specific metrics as readable columns instead of raw JSON:**
```sql
SELECT question,
       row_data->>'faithfulness' AS faithfulness,
       row_data->>'answer_relevancy' AS answer_relevancy,
       row_data->>'failure_cause' AS failure_cause
FROM eval_results
LIMIT 10;
```

## Connecting from code (e.g. the UI)

Use the **pooler** connection (not the direct `db.xxx.supabase.co` one —
that requires IPv6, which isn't available on every network/tier):

```
postgresql://postgres.<project-ref>:<password>@aws-1-eu-west-2.pooler.supabase.com:6543/postgres
```

For a Next.js server-side route (never expose this in client-side code):
keep the connection string in a non-`NEXT_PUBLIC_` env var, connect with
the `pg` package, and query the tables above from an API route.

## Known limitations

- **Supabase free tier** — pauses after 7 days of inactivity. If a query
  suddenly fails to connect, check the dashboard and manually resume the
  project.
- **`run_batch_topk.py` has no built-in aggregator** — `aggregate_topk_results.py`
  fills that gap for now (see note in step 2 above).
- **`run_summary` table is unused** — reserved for future aggregate stats,
  nothing writes to it currently.
- **Results directory is git-ignored** — `results/` and its contents
  aren't committed, so a fresh clone of this repo has no data until
  someone runs the sweep scripts themselves.