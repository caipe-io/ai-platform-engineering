# CI/CD Quality Gate

Use DeepEval evaluation as a **quality gate** in a CI/CD pipeline. After scoring,
the gate compares aggregated metrics against configured thresholds and exits
non-zero when a hard threshold is missed, so a pipeline can block a merge or
deployment on a quality regression.

---

## How it works

```
run evaluation → gate aggregates metrics → compare against thresholds
                                    │
                          any hard violation? ──yes→ exit 1 → build fails
                                    └──────────────no→ exit 0 → build passes
```

The gate is just a process that returns a non-zero exit code on failure, so it
works in any CI system (GitHub Actions, GitLab CI, Jenkins …) — you
only need to run the command and let the pipeline react to the exit code.



## Components

| File | Purpose |
| --- | --- |
| `src/deepeval_eval/engine/gate.py` | Gate core: defines in-source `DEFAULT_THRESHOLDS`, resolves overrides (`resolve_gate_config`), aggregates scores, compares thresholds, renders summary, sets exit code |
| `gate_thresholds.yaml` | (Optional) Custom threshold configuration override file |

---

## Running locally

Add `--gate` to any `eval` command (works for `enterprise`, `hotpotqa`, and `precomputed` pipelines):

```bash
# Precomputed 
python src/deepeval_eval/precomputed_deepeval.py \
  --benchmark hotpotqa --answer-mode generate --max-items 30 --gate

# Full RAG 
python src/deepeval_eval/hotpotqa_deepeval.py eval \
  --max-items 50 --top-k 5 --gate
```

By default, the gate uses **in-source default thresholds** (`DEFAULT_THRESHOLDS`). You can point at a custom config file with `--gate-config path/to/config.yaml`.

Re-apply the gate to an existing results file without re-running the evaluation:

```bash
# Uses in-source default thresholds if --config is omitted
python -m deepeval_eval.engine.gate \
  --results results/hotpotqa_deepeval_results_TIMESTAMP.json

# Or specify a custom config file override
python -m deepeval_eval.engine.gate \
  --results results/hotpotqa_deepeval_results_TIMESTAMP.json \
  --config custom_thresholds.yaml
```

---

## Configuration

The quality gate supports **in-source Python default thresholds** out-of-the-box, as well as optional **YAML/JSON file** or **dictionary overrides**.

### In-Source Defaults (`DEFAULT_THRESHOLDS`)

```python
DEFAULT_THRESHOLDS = {
    "metrics": {
        "answer_relevancy": {"mean": 0.70, "pass_rate": 0.90, "severity": "soft"},
        "faithfulness": {"mean": 0.80, "pass_rate": 0.90, "severity": "soft"},
        "contextual_relevancy": {"mean": 0.60, "severity": "soft"},
        "contextual_precision": {"mean": 0.60, "severity": "soft"},
        "contextual_recall": {"mean": 0.60, "severity": "soft"},
    },
    "retrieval": {
        "doc_id_recall": {"mean": 0.60, "severity": "soft"},
        "doc_id_precision": {"mean": 0.50, "severity": "soft"},
    },
    "error_tolerance": 0.10,
}
```

### Custom Overrides (`gate_thresholds.yaml`)

To customize thresholds, supply a `gate_thresholds.yaml` (or JSON) file:

```yaml
metrics:
  answer_relevancy:  { mean: 0.70, pass_rate: 0.90, severity: soft }
  faithfulness:      { mean: 0.80, pass_rate: 0.90, severity: soft }
  # contextual_relevancy / contextual_precision / contextual_recall ...

retrieval:
  doc_id_recall:     { mean: 0.60, severity: soft }
  doc_id_precision:  { mean: 0.50, severity: soft }

error_tolerance: 0.10
```

| Field | Meaning |
| --- | --- |
| `mean` | The metric's average score must be ≥ this value |
| `pass_rate` | Of the scored cases, the fraction passing the metric threshold must be ≥ this value |
| `severity` | `hard` = fail the build; `soft` = warn only |
| `retrieval.*` | Retrieval metrics — meaningful only when questions carry ground-truth `expected_doc_ids` |
| `error_tolerance` | Max fraction of metric evaluations allowed to error (e.g. LLM timeouts); exceeding it is a hard failure |

**Decision rule:** any **hard** violation fails the gate (exit 1); only soft
violations pass with a warning (exit 0). An error rate above `error_tolerance`,
or an empty result set, is also a hard failure (so a broken or empty run can
never be mistaken for a passing one).

---

## Comprehensive Guide: Running Evaluations via Pytest

You can run quality gate checks and end-to-end evaluation pipelines directly inside your `pytest` test suite in CI/CD environments.

---

### 1. Requirements & Operating Modes

| Requirement / Mode | Without CAIPE (Standalone / Mock) | With CAIPE (Agentic Supervisor / RAG Server) |
| --- | --- | --- |
| **CAIPE Infrastructure** | Not required | CAIPE Supervisor running (`http://localhost:8000`) |
| **LLM Provider** | OpenAI API / Mock endpoint | Handled by CAIPE Agent / Supervisor |
| **Environment Vars** | `OPENAI_API_KEY`, `OPENAI_ENDPOINT`, `OPENAI_MODEL_NAME` | `CAIPE_SUPERVISOR_URL`, `CAIPE_AGENT_ID`, `CAIPE_DATASOURCE_ID` |
| **EvalConfig Mode** | `agentic = False` (or precomputed) | `agentic = True` |

#### Data Source Options for Question Sets

- **Option A: File-Based Question Sets (No Database Required)**
  - Pass `--questions-file data/questions.json` or set `questions_file = Path("data/questions.json")` in `EvalConfig`.
  - Works standalone in CI/CD without spinning up a PostgreSQL database.
- **Option B: Database-Backed Question Sets (`caipe_eval` Postgres DB)**
  - Pass `--question-set-id <id>` or set `question_set_id = <id>` in `EvalConfig`.
  - Requires PostgreSQL connection settings: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (or `DATABASE_URL`).

#### Authentication & OpenFGA / ReBAC Requirements

- **Production / Enforced Security Mode**:
  - Requires Keycloak OIDC issuer settings (`OIDC_ISSUER_URL`, `OIDC_AUDIENCE`).
  - Requires valid OIDC Bearer token (`DEEPEVAL_API_KEY`, `CAIPE_OIDC_TOKEN`, or `BEARER_TOKEN`).
  - Enforces OpenFGA relationship tuples (e.g. `question_set:<id>#owner@user:<user_id>`).
- **Local & Automated CI Testing (Auth Bypass)**:
  - Set environment variable `ALLOW_UNAUTHENTICATED_ACCESS=true` (or `CAIPE_UNSAFE_RBAC_BYPASS=true`).
  - Bypasses Keycloak OIDC token verification and OpenFGA relationship checks during automated test runs.

---

### 2. Pytest Execution Commands

Run the standard evaluator unit and gate test suite:

```bash
# Run unit & gate test suite
uv run python -m pytest tests/test_gate.py tests/test_eval_engine.py -v

# Run live E2E server tests (spawns managed server on free port with ALLOW_UNAUTHENTICATED_ACCESS=true)
uv run python -m pytest tests/test_e2e_live.py -v -m e2e
```

---

### 3. Writing Custom Pytest Evaluation & Quality Gate Tests

Below are complete Python `pytest` snippets for both Standalone and CAIPE modes.

#### Pattern A: Programmatic Pytest Quality Gate on Existing Results

```python
import json
from pathlib import Path
import pytest
from deepeval_eval.engine.gate import evaluate_gate, resolve_gate_config

def test_evaluation_quality_gate():
    results_path = Path("results/latest_eval_results.json")
    if not results_path.exists():
        pytest.skip("Evaluation results file not found.")

    with open(results_path) as f:
        data = json.load(f)

    # Resolves in-source DEFAULT_THRESHOLDS if file path is None or missing
    config = resolve_gate_config(Path("gate_thresholds.yaml"))

    report = evaluate_gate(data["results"], config)

    assert report.passed, f"Quality gate failed with hard violations: {report.hard_violations}"
```

#### Pattern B: End-to-End Evaluation & Gate Test (Standalone Mode - File Based)

```python
import os
import pytest
from deepeval_eval.core.config import EvalConfig
from deepeval_eval.engine.eval_engine import run_evaluation_pipeline
from deepeval_eval.engine.gate import evaluate_gate, resolve_gate_config

@pytest.mark.asyncio
async def test_standalone_rag_evaluation_gate(tmp_path):
    # Set auth bypass for local test run
    os.environ["ALLOW_UNAUTHENTICATED_ACCESS"] = "true"

    config = EvalConfig(
        dataset_name="enterprise",
        questions_file=Path("data/sample_questions.json"), # File-based question set
        max_items=5,
        agentic=False,
        gate=True,
        results_dir=tmp_path,
    )

    # Execute pipeline
    eval_results = await run_evaluation_pipeline(config)
    assert eval_results is not None

    # Evaluate Quality Gate
    gate_config = resolve_gate_config(config.gate_config)
    report = evaluate_gate(eval_results.to_dict_list(), gate_config)

    assert report.passed, f"Gate failure: {report.hard_violations}"
```

#### Pattern C: End-to-End Evaluation Test (CAIPE Mode - DB Question Set & ReBAC)

```python
import os
import pytest
from deepeval_eval.core.config import EvalConfig
from deepeval_eval.engine.eval_engine import run_evaluation_pipeline
from deepeval_eval.engine.gate import evaluate_gate, resolve_gate_config

@pytest.mark.asyncio
async def test_caipe_rag_evaluation_gate(tmp_path):
    # Configure CAIPE Supervisor & DB connection
    os.environ["CAIPE_SUPERVISOR_URL"] = "http://localhost:8000"
    os.environ["CAIPE_AGENT_ID"] = "caipe-agent"
    os.environ["POSTGRES_HOST"] = "localhost"
    os.environ["POSTGRES_DB"] = "caipe_eval"
    
    # Configure auth token or bypass
    os.environ["ALLOW_UNAUTHENTICATED_ACCESS"] = "true"  # Set to False to enforce Keycloak/OpenFGA

    config = EvalConfig(
        question_set_id=1,  # Database-backed question set
        max_items=10,
        agentic=True,
        gate=True,
        results_dir=tmp_path,
    )

    eval_results = await run_evaluation_pipeline(config)
    assert eval_results is not None

    report = evaluate_gate(eval_results.to_dict_list(), resolve_gate_config())
    assert report.passed
```

---

## GitHub Actions CI/CD Integration Example

Here is a complete `.github/workflows/quality_gate.yml` workflow example that runs unit tests via `pytest` and evaluates benchmark RAG quality gates on every Pull Request:

```yaml
name: CI/CD Quality Gate & Test Suite

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  test-and-gate:
    runs-on: ubuntu-latest

    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.13'

      - name: Install uv and dependencies
        run: |
          curl -LsSf https://astral.sh/uv/install.sh | sh
          uv venv
          uv pip install -e .[dev]

      - name: Step 1 - Syntax & Pytest Unit Tests
        run: |
          uv run pytest -v --cov=src

      - name: Step 2 - Precomputed Evaluation & Quality Gate
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_ENDPOINT: ${{ secrets.OPENAI_ENDPOINT }}
          OPENAI_MODEL_NAME: "gpt-4o"
        run: |
          uv run python src/deepeval_eval/engine/deepeval_evaluator.py eval \
            --benchmark hotpotqa \
            --precompute \
            --answer-mode generate \
            --max-items 20 \
            --gate \
            --gate-config gate_thresholds.yaml
```

