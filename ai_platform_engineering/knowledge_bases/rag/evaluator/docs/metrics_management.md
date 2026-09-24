# Dynamic DeepEval Metrics & Metric Sets Management

This document details the architecture, design principles, and operational workflows for dynamically managing **DeepEval Metrics** and **Metric Sets** within the CAIPE RAG Evaluator.

---

## 1. Executive Summary & Design Principles

Similar to [Prompt Styles](rest_api_service.md#prompt-styles-management-api-apiv1prompt-styles) and [Question Sets](rest_api_service.md#question-sets-management-api-apiv1question-sets), the CAIPE Evaluator decouples evaluation metric definitions and bundles from static codebase constants into a persistent, API-manageable system.

### Core Principles

1. **Strict Code vs. Configuration Boundary**:
   - **Code-backed metrics (`builtin` and `custom_code`) cannot be created purely from configuration**. Their mathematical, heuristic, or DeepEval evaluation logic is implemented in Python code. Configuration manages their **selection, thresholds, hyperparameters, and inclusion in Metric Sets**.
   - **Only G-Eval metrics (`g_eval`) can be created and modified purely via configuration**. G-Eval metrics rely on LLM-as-a-judge prompt criteria and evaluation steps executed by DeepEval's `GEval` engine.
2. **Admin-Only Mutation Guard**:
   - All metrics and metric sets are **publicly readable** to all authenticated users.
   - Creation (`POST`), updating (`PUT`), and deletion (`DELETE`) are strictly guarded by `require_role(Role.ADMIN)`. Non-admin modification attempts return `403 Forbidden`.
3. **Protected System Defaults (`is_system=True`)**:
   - Built-in metrics and system baseline metric sets seeded on startup are marked `is_system=True` and protected from accidental deletion.
4. **CLI & REST Parity**:
   - Dynamic metric selection is available both via the REST API (`POST /api/v1/evaluations/jobs`) and the CLI (`deepeval_evaluator.py`).

---

## 2. Taxonomy of Metric Types

| Category | Type Identifier (`metric_type`) | Backed By | Dynamic Creation via API? | Tunable via API/Config? | Examples |
| :--- | :---: | :--- | :---: | :---: | :--- |
| **DeepEval Built-ins** | `builtin` | `deepeval.metrics` Python classes | No | Yes (thresholds & params) | `AnswerRelevancyMetric`, `FaithfulnessMetric`, `ContextualPrecisionMetric`, `ContextualRecallMetric`, `ContextualRelevancyMetric`, `HallucinationMetric`, `ToxicityMetric`, `BiasMetric`, `SummarizationMetric` |
| **Repository Custom Code** | `custom_code` | Repository Python classes implementing `BaseMetric` protocol | No | Yes (thresholds & params) | `MRRMetric`, `NDCGAtKMetric`, `RetrievalRecallMetric`, `RetrievalPrecisionMetric`, `NormalizedExactMatchMetric`, `ContainsReferenceMetric` |
| **Dynamic G-Eval Rubrics** | `g_eval` | DeepEval `GEval` prompt execution engine | **Yes** | **Yes** (criteria, steps, params, threshold) | `AnswerCorrectnessMetric`, domain-specific safety checks, persona adherence |

---

## 3. Data Architecture & Duck Typing

```mermaid
flowchart TD
    subgraph Storage["PostgreSQL Database Layer"]
        DBMetrics[("eval_metrics Table")]
        DBMetricSets[("metric_sets & metric_set_items Tables")]
        MDB["MetricDBManager<br/>(db/metric_db_manager.py)"]
        DBMetrics <--> MDB
        DBMetricSets <--> MDB
    end

    subgraph API["REST API Layer (/api/v1/metrics & /api/v1/metric-sets)"]
        MetricsRouter["/api/v1/metrics"]
        MetricSetsRouter["/api/v1/metric-sets"]
        BuiltinsEndpoint["GET /api/v1/metrics/builtins"]
        AdminGuard["Admin Mutation Guard<br/>require_role(Role.ADMIN)"]
        
        MDB <--> MetricsRouter
        MDB <--> MetricSetsRouter
        MetricsRouter --> BuiltinsEndpoint
        MetricsRouter --- AdminGuard
        MetricSetsRouter --- AdminGuard
    end

    subgraph Engine["Evaluation Engine & Dynamic Factory"]
        Registry["METRIC_REGISTRY<br/>(engine/metrics.py)"]
        Exec["Evaluation Engine<br/>(engine/eval_engine.py)"]
        TestCase["LLMTestCase<br/>(input, actual_output, expected_output, retrieval_context)"]
        
        MDB --> Registry
        Registry --> Exec
        TestCase -->|Duck Typing .measure(test_case)| Exec
    end

    subgraph Invocation["Job Execution Request"]
        APIReq["REST EvaluationRequest<br/>(metric_set='rag_core', metrics=['faithfulness'])"]
        CLIReq["CLI Flags<br/>(--metric-set rag_core --metrics faithfulness)"]
        APIReq --> Exec
        CLIReq --> Exec
    end
```

### DeepEval Duck Typing & `LLMTestCase` Flow

DeepEval metrics evaluate test runs via **Duck Typing**. The evaluation engine instantiates metric instances and passes a standardized `LLMTestCase` container:

```python
test_case = LLMTestCase(
    input=question,                        # User query prompt
    actual_output=answer,                  # Generated model answer
    expected_output=reference,             # Golden ground truth reference
    retrieval_context=trimmed_contexts,    # Chunks retrieved from RAG / Vector DB
    context=row.get("context") or [],      # Optional golden reference context
    metadata={                             # Dynamic extra context & doc references
        "retrieved_doc_ids": current_retrieved_ids,
        "expected_doc_ids": row.get("expected_doc_ids", []),
        "top_k": config.top_k,
    },
)
```

Each metric extracts only the attributes it requires:
- `FaithfulnessMetric` consumes `actual_output` and `retrieval_context`.
- `AnswerRelevancyMetric` consumes `input` and `actual_output`.
- `ContextualPrecisionMetric` consumes `input`, `expected_output`, and `retrieval_context`.
- `NormalizedExactMatchMetric` consumes `actual_output` and `expected_output`.
- `MRRMetric` & `NDCGAtKMetric` consume `metadata["retrieved_doc_ids"]` and `metadata["expected_doc_ids"]`.
- `GEval` dynamically extracts the parameters declared in its configuration (`evaluation_params`).

### How G-Eval Metrics Are Built Dynamically

When an evaluation job runs, [`build_metric_instance()`](../src/deepeval_eval/engine/metrics.py) constructs a DeepEval `GEval` instance dynamically from the database configuration:

```python
elif metric_type == "g_eval":
    # 1. Map string parameter names to DeepEval SingleTurnParams enums
    eval_params_raw = metric_cfg.get("evaluation_params") or ["input", "actual_output"]
    eval_params = [
        PARAM_NAME_TO_SINGLE_TURN_PARAM[p.lower()]
        for p in eval_params_raw
        if p.lower() in PARAM_NAME_TO_SINGLE_TURN_PARAM
    ] or [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT]

    criteria = metric_cfg.get("criteria")
    evaluation_steps = metric_cfg.get("evaluation_steps") or None

    # 2. Instantiate DeepEval's native GEval judge instance
    return GEval(
        name=name,
        criteria=criteria,
        evaluation_steps=evaluation_steps,
        evaluation_params=eval_params,
        threshold=threshold,
        model=judge_model,
        async_mode=parameters.get("async_mode", False),
        verbose_mode=parameters.get("verbose_mode", False),
    )
```

#### G-Eval Constructor Parameter Breakdown:

1. **`name` (`str`)**:
   The unique metric identifier (e.g. `citation_correctness`, `answer_correctness`, `brand_voice`). Surfaced in evaluation summaries, CSV reports, and charts.
2. **`criteria` (`str | None`)**:
   High-level natural language description of what the judge should assess (e.g. *"Evaluate whether the answer cites source documents corresponding to expected reference outputs without fabricating citation IDs."*).
3. **`evaluation_steps` (`list[str] | None`)**:
   Step-by-step reasoning instructions guiding the LLM judge during evaluation (e.g. step 1: check citations, step 2: verify against context, step 3: penalize hallucinations, step 4: score 0.0–1.0).
4. **`evaluation_params` (`list[SingleTurnParams]`)**:
   Specifies which `LLMTestCase` attributes are passed to the judge model's evaluation prompt. Mapped via `PARAM_NAME_TO_SINGLE_TURN_PARAM`:
   - `"input"` $\rightarrow$ `SingleTurnParams.INPUT` (user question prompt)
   - `"actual_output"` $\rightarrow$ `SingleTurnParams.ACTUAL_OUTPUT` (agent generated answer)
   - `"expected_output"` $\rightarrow$ `SingleTurnParams.EXPECTED_OUTPUT` (golden reference answer)
   - `"retrieval_context"` $\rightarrow$ `SingleTurnParams.RETRIEVAL_CONTEXT` (retrieved document chunks)
   - `"context"` $\rightarrow$ `SingleTurnParams.CONTEXT` (golden background knowledge)
5. **`threshold` (`float`)**:
   Minimum numeric score ($0.0 \dots 1.0$) required for the metric to be marked `success=True`.
6. **`model` (`Any`)**:
   The evaluator judge LLM client instance (e.g. GPT-4o, Claude 3.5 Sonnet, or Ollama local model).
7. **`async_mode` (`bool`) & `verbose_mode` (`bool`)**:
   Execution controls for concurrent batch scoring and step-by-step judge rationale logging.

---

## 4. PostgreSQL Schema

```sql
-- Individual Metric Definitions (Built-in, Custom Code, and Dynamic G-Eval)
CREATE TABLE IF NOT EXISTS eval_metrics (
    name              VARCHAR(100) PRIMARY KEY,
    display_name      VARCHAR(200) NOT NULL,
    description       TEXT,
    metric_type       VARCHAR(50) NOT NULL DEFAULT 'builtin', -- 'builtin', 'custom_code', 'g_eval'
    metric_class      VARCHAR(100),
    threshold         FLOAT NOT NULL DEFAULT 0.5,
    parameters        JSONB DEFAULT '{}'::jsonb,
    evaluation_params JSONB DEFAULT '[]'::jsonb,
    criteria          TEXT,
    evaluation_steps  JSONB DEFAULT '[]'::jsonb,
    visibility        VARCHAR(20) NOT NULL DEFAULT 'public',
    owner_id          VARCHAR(100),
    owner_team        VARCHAR(100),
    is_system         BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Named Metric Sets (Reusable Bundles)
CREATE TABLE IF NOT EXISTS metric_sets (
    name         VARCHAR(100) PRIMARY KEY,
    display_name VARCHAR(200) NOT NULL,
    description  TEXT,
    visibility   VARCHAR(20) NOT NULL DEFAULT 'public',
    owner_id     VARCHAR(100),
    owner_team   VARCHAR(100),
    is_system    BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Join Table for Metric Set Items
CREATE TABLE IF NOT EXISTS metric_set_items (
    metric_set_name  VARCHAR(100) NOT NULL REFERENCES metric_sets(name) ON DELETE CASCADE,
    metric_name      VARCHAR(100) NOT NULL REFERENCES eval_metrics(name) ON DELETE CASCADE,
    custom_threshold FLOAT,
    PRIMARY KEY (metric_set_name, metric_name)
);
```

---

## 5. REST API Reference

### Metrics API (`/api/v1/metrics`)

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/metrics` | Authenticated (Public) | List all configured metrics (built-in, custom code, G-Eval). |
| `GET` | `/api/v1/metrics/builtins` | Authenticated (Public) | List all code-backed built-in metric types with supported schemas. |
| `GET` | `/api/v1/metrics/{name}` | Authenticated (Public) | Get full definition and parameters for a specific metric. |
| `POST` | `/api/v1/metrics` | **Admin Only** | Create a new custom G-Eval metric. |
| `PUT` | `/api/v1/metrics/{name}` | **Admin Only** | Update metric thresholds, parameters, or G-Eval criteria. |
| `DELETE` | `/api/v1/metrics/{name}` | **Admin Only** | Delete a custom G-Eval metric (blocked on `is_system=True`). |

### Metric Sets API (`/api/v1/metric-sets`)

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/metric-sets` | Authenticated (Public) | List all configured metric set bundles and their items. |
| `GET` | `/api/v1/metric-sets/{name}` | Authenticated (Public) | Get details and resolved metrics for a specific metric set. |
| `POST` | `/api/v1/metric-sets` | **Admin Only** | Create a new metric set bundle. |
| `PUT` | `/api/v1/metric-sets/{name}` | **Admin Only** | Update a metric set or its bundled metric items. |
| `DELETE` | `/api/v1/metric-sets/{name}` | **Admin Only** | Delete a metric set bundle (blocked on `is_system=True`). |

---

## 6. Examples: Adding & Using Metrics

### 1. Creating Custom Dynamic G-Eval Metrics (via API)

Admins can define custom domain-specific LLM-as-a-judge criteria and scoring rubrics.

#### Example A: Technical Clarity & Conciseness
```bash
curl -X POST "http://localhost:8000/api/v1/metrics" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "technical_clarity",
    "display_name": "Technical Clarity & Conciseness",
    "description": "Evaluates whether the technical explanation is clear, accurate, and devoid of filler",
    "metric_type": "g_eval",
    "threshold": 0.75,
    "evaluation_params": ["input", "actual_output"],
    "criteria": "Evaluate whether the answer directly answers the technical question with precise engineering terminology without fluff.",
    "evaluation_steps": [
      "Check if technical terminology is accurate and well-explained.",
      "Penalize redundant pleasantries, boilerplate, or circular reasoning.",
      "Assign a score from 0.0 to 1.0 based on clarity and precision."
    ]
  }'
```

#### Example B: Zero Trust Security Architecture Adherence
```bash
curl -X POST "http://localhost:8000/api/v1/metrics" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "zero_trust_adherence",
    "display_name": "Zero Trust Security Adherence",
    "description": "Validates that architecture proposals strictly enforce zero-trust security tenets",
    "metric_type": "g_eval",
    "threshold": 0.80,
    "evaluation_params": ["input", "actual_output", "expected_output"],
    "criteria": "Verify that the generated response adheres to zero trust principles: explicit verification, least privilege access, and assumed breach.",
    "evaluation_steps": [
      "Check if the answer mandates authentication and authorization for every request.",
      "Verify that least-privilege scoping is enforced.",
      "Ensure no implicit perimeter-based trust assumptions exist.",
      "Score 1.0 if all tenets are fully met, 0.5 if partially met, 0.0 if perimeter trust is assumed."
    ]
  }'
```

#### Example C: Citation Correctness & Grounding
```bash
curl -X POST "http://localhost:8000/api/v1/metrics" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "citation_correctness",
    "display_name": "Citation Correctness",
    "description": "Evaluates whether the generated response accurately cites the expected reference documents and sources",
    "metric_type": "g_eval",
    "threshold": 0.70,
    "evaluation_params": ["input", "actual_output", "expected_output", "retrieval_context"],
    "criteria": "Evaluate whether the answer accurately and correctly cites the source documents corresponding to expected reference outputs without fabricating citation IDs.",
    "evaluation_steps": [
      "Check if citations or document identifiers are present in actual_output.",
      "Verify that cited documents match the retrieved context and expected reference documents.",
      "Penalize hallucinated or missing citations.",
      "Assign a score between 0.0 and 1.0 reflecting citation precision and coverage."
    ]
  }'
```

---

### 2. Creating a Custom Metric Set Bundle (via API)

Combine built-in metrics, custom code metrics, and custom G-Eval metrics into a single unified test suite:

```bash
curl -X POST "http://localhost:8000/api/v1/metric-sets" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "citation_bias_suite",
    "display_name": "Citation Correctness & Bias Suite",
    "description": "Evaluates response citation precision alongside built-in bias detection",
    "visibility": "public",
    "metrics": [
      {"metric_name": "bias", "custom_threshold": 0.30},
      {"metric_name": "citation_correctness", "custom_threshold": 0.70}
    ]
  }'
```

---

### 3. Running an Evaluation Using Dynamic Metrics


#### Via REST API (Bundled Metric Set):
```json
POST /api/v1/evaluations/jobs
{
  "dataset_name": "enterprise",
  "metric_set": "production_security_gate"
}
```

#### Via REST API (Ad-hoc Metric List):
```json
POST /api/v1/evaluations/jobs
{
  "dataset_name": "enterprise",
  "metrics": ["faithfulness", "hallucination", "zero_trust_adherence", "technical_clarity"]
}
```

#### Via CLI:
```bash
# Evaluate using a metric set bundle
uv run python -m deepeval_eval.engine.deepeval_evaluator eval \
  --dataset-name enterprise \
  --metric-set production_security_gate

# Evaluate selecting specific individual metrics (built-ins + custom G-Eval)
uv run python -m deepeval_eval.engine.deepeval_evaluator eval \
  --dataset-name enterprise \
  --metrics faithfulness,hallucination,zero_trust_adherence,mrr

# List all available metrics and standard metric sets
uv run python -m deepeval_eval.engine.deepeval_evaluator eval --list-metrics
```

---

## 7. Supported Metrics & Future Work

Not all DeepEval metrics apply to standard single-turn Text/RAG evaluations. Below is the operational matrix of supported metrics, requirements, and roadmap items:

###  Fully Supported (Standard RAG & Text Generation)

These metrics evaluate text and retrieval without special instrumentation:

| Metric Name | Type | Evaluation Focus | Input Requirements |
| :--- | :---: | :--- | :--- |
| **`answer_relevancy`** | Semantic | Did the response directly answer the query? | `input`, `actual_output` |
| **`faithfulness`** | Semantic | Is the answer grounded in the retrieved text? | `actual_output`, `retrieval_context` |
| **`answer_correctness`** | Semantic | Factual alignment with expected answer. | `input`, `actual_output`, `expected_output` |
| **`contextual_precision`** | Ranking | Did relevant chunks rank higher than irrelevant? | `input`, `expected_output`, `retrieval_context` |
| **`contextual_recall`** | Semantic | Was all information needed for the golden answer retrieved? | `expected_output`, `retrieval_context` |
| **`contextual_relevancy`** | Extraction | Percentage of retrieved text that was relevant. | `input`, `actual_output`, `retrieval_context` |
| **`hallucination`** | Semantic | Contradictions between generated output and context. | `actual_output`, `context` |
| **`bias`** | Safety | Gender, racial, or political bias detection. | `actual_output` |
| **`toxicity`** | Safety | Hate speech, profanity, or hostility detection. | `actual_output` |
| **`pii_leakage`** | Safety | Leaked keys, passwords, emails, or personal data. | `input`, `actual_output` |
| **`task_completion`** | Functional | Did the model fulfill the goal described in prompt? | `input`, `actual_output` |
| **`mrr`** | IR Scorer | Mean Reciprocal Rank of first relevant document. | `expected_doc_ids`, `retrieved_doc_ids` |
| **`ndcg_at_k`** | IR Scorer | Normalized Discounted Cumulative Gain at $K$. | `expected_doc_ids`, `retrieved_doc_ids` |
| **`retrieval_recall`** | IR Scorer | Expected document recall. | `expected_doc_ids`, `retrieved_doc_ids` |
| **`retrieval_precision`** | IR Scorer | Expected document precision. | `expected_doc_ids`, `retrieved_doc_ids` |
| **`normalized_exact_match`** | Text | Punctuation/casing normalized exact match. | `actual_output`, `expected_output` |
| **`contains_reference`** | Text | Substring presence check. | `actual_output`, `expected_output` |
| **`image_coherence`** | Vision | Evaluates visual and semantic consistency of generated images. | Image paths/URLs in `actual_output` |
| **`image_editing`** | Vision | Evaluates quality and adherence of edited images against source. | `input_images`, `actual_output` |
| **`image_helpfulness`** | Vision | Evaluates relevance and utility of image to user query. | `input`, `actual_output` (images) |
| **`image_reference`** | Vision | Evaluates generated image alignment with golden reference image. | `actual_output`, `expected_output` (images) |
| **`text_to_image`** | Vision | Evaluates image generation fidelity against text prompt. | `input` (text), `actual_output` (images) |

---

### ⏳ Future Work & Trace-Dependent Metrics

The following metrics are defined in the metric catalog but require additional trace payloads or structured tool-call arrays from multi-step agent executions:

| Metric Category | Metrics | Current Status / Missing Prerequisite | Target Roadmap |
| :--- | :--- | :--- | :--- |
| **Agentic Tool Calling** | `tool_correctness`, `argument_correctness`, `mcp_use` | **Future Work**: Requires attaching structured `tools_called` and `expected_tools` arrays to the dataset question definition or agent runner. | Agent Tooling Evaluation Milestone |
| **Execution Trace Auditing** | `agent_loop_detection`, `plan_adherence`, `plan_quality`, `step_efficiency` | **Future Work**: Requires OpenTelemetry / LangSmith agent execution graph trace bridging into `LLMTestCase`. | Agent Tracing Milestone |



