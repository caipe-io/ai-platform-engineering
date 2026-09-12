# Evaluator REST API: Old vs. New Contract Comparison & Migration

This document provides a detailed side-by-side comparison of the DeepEval Evaluator REST API before and after the removal of the single-node local disk cache, the introduction of PostgreSQL persistence, and schema harmonization.

---

## 1. Request Submission Diff (`POST /eval/jobs` & `POST /eval/jobs/upload`)

| Parameter / Field | Old Contract (Before) | New Contract (Now) | UI Action / Impact |
| :--- | :--- | :--- | :--- |
| `save_to_db` | `boolean` (default: `false`) | **Removed** | Remove from UI form. DB persistence is now automatically handled. |
| `trace_log` | `boolean` (default: `false`) | **Removed** | Remove from UI form. Local disk trace logs replaced by OpenTelemetry. |
| `llm_base_url` | `string \| null` | **Removed** | Remove from UI form. LLM routing is configured centrally on the server. |
| `llm_api_key` | `string \| null` | **Removed** | Remove from UI form. API keys are managed securely server-side. |
| `agent_url` | `string \| null` | **Removed** | Remove from UI form. Agent routing uses dynamic service discovery. |
| `metric_set` | *Not available* | **`string \| null` (Added)** | Add dropdown to pick bundle presets (e.g. `"rag_core"`). |
| `metrics` | *Not available* | **`string[] \| null` (Added)** | Add multi-select for individual metric names (e.g. `["faithfulness"]`). |
| `agentic` | `boolean` (default: `false`) | `boolean` (default: `true`) | Now defaults to `true` (agentic supervisor routing). |
| `force_rerun` | `boolean` (default: `false`) | `boolean` (default: `false`) | Unchanged. |

---

## 2. Top-Level Results Envelope Diff (`GET /jobs/{job_id}/results`)

| Top-Level Key | Old Contract (Before) | New Contract (Now) | UI Action / Impact |
| :--- | :--- | :--- | :--- |
| `job_id` | `string` | `string` | Unchanged. |
| `status` | `JobStatusEnum` | `JobStatusEnum` | Unchanged (`pending`, `running`, `completed`, `failed`). |
| `created_at` | `float` (timestamp) | `float` (timestamp) | Unchanged. |
| `completed_at` | `float \| null` | `float \| null` | Unchanged. |
| `cached` | `boolean` (from local disk files) | `boolean` (from PostgreSQL deduplication) | Compatible. Indicates whether run hit cache. |
| `config_args` | `dict` | `dict` | Unchanged. |
| `summary` | `dict` (flattened metrics) | `dict` (nested `metrics` dict) | **Update access path** to `summary.metrics.<name>`. |
| `results` | `list[dict]` (legacy field names) | `list[dict]` (standardized field names) | **Update field access** (see Section 4). |
| `saved_to_db` | `boolean` (`true` / `false`) | **Removed** | Do not rely on `data.saved_to_db`. |
| `user_info` | `dict \| null` | `dict \| null` | Unchanged. |

---

## 3. Summary Object Diff (`data.summary`)

| Summary Property | Old Contract (Before) | New Contract (Now) | UI Migration Note |
| :--- | :--- | :--- | :--- |
| Question Count | `total_questions: 5` | `total_items: 5` | Use `summary.total_items`. |
| Metric Scores | Flattened keys:<br>`average_faithfulness: 0.95`<br>`average_answer_relevance: 0.92`<br>`average_context_precision: 0.88` | Nested dictionary:<br>`metrics: {`<br>&nbsp;&nbsp;`"faithfulness": 0.95,`<br>&nbsp;&nbsp;`"answer_relevancy": 0.92,`<br>&nbsp;&nbsp;`"retrieval_recall": 1.0,`<br>&nbsp;&nbsp;`"context_precision": 0.88`<br>`}` | Iterate with `Object.entries(summary.metrics)` or access `summary.metrics[name]`. |
| Percentile Latency | `0.0` | `p50_latency: 1.25`<br>`p95_latency: 2.10` | Render latency distribution cards. |
| Token Breakdown | Not structured | `total_tokens: 3665`<br>`deepeval_evaluator_usage: {`<br>&nbsp;&nbsp;`prompt_tokens: 28317,`<br>&nbsp;&nbsp;`completion_tokens: 3477,`<br>&nbsp;&nbsp;`total_tokens: 31794`<br>`}` | Display token usage stats. |
| Failure Causes | Not available | `failure_causes: { "hallucination": 1 }` | Render failure cause tags if present. |

---

## 4. Per-Question Result Item Diff (`data.results[i]`)

| Purpose | Old Field Name (Before) | New Standardized Field Name (Now) | UI Migration Note |
| :--- | :--- | :--- | :--- |
| Question ID | `question_id` | `question_id` | Unchanged. |
| Original Query Text | `question` or `user_input` | **`user_input`** | Original raw user question from the dataset (replace `item.question` with `item.user_input`). |
| Evaluator Dispatched Query | *Not captured* | **`actual_input`** (Added) | The actual enriched / styled prompt query sent by the evaluator to the target agent or LLM (e.g. prompt style template or agentic query). |
| Ground Truth Reference | `expected_output` or `ground_truth` | **`reference`** | Replace `item.expected_output` with `item.reference`. |
| Generated Output | `actual_output`, `response`, or `answer` | **`actual_output`** | Use `item.actual_output`. |
| Ground Truth Passage | `contexts` (list) | **`context`** (string) | Target ground truth context. |
| Retrieved Passages | `contexts` (list) | **`retrieved_contexts`** (list of strings) | Replace `item.contexts` with `item.retrieved_contexts`. |
| Document IDs | `doc_ids` (list) | **`retrieved_doc_ids`** and **`expected_doc_ids`** | Separate expected vs retrieved doc IDs. |
| Metric Scores | `metrics: { "answer_relevance": 0.94 }` | `metrics: { "answer_relevancy": 0.94 }` | Standardized key names (e.g. `answer_relevancy`). |
| Query Latency | `latency` or `latency_sec` | **`latency`** (float seconds) | Use `item.latency`. |

---

## 5. Side-by-Side JSON Payload Example

````carousel
```json
// --- OLD RESPONSE (BEFORE) ---
{
  "job_id": "job_12345",
  "status": "completed",
  "created_at": 1724700000.0,
  "completed_at": 1724700045.0,
  "cached": false,
  "saved_to_db": true,
  "summary": {
    "total_questions": 1,
    "average_faithfulness": 0.95,
    "average_answer_relevance": 0.92
  },
  "results": [
    {
      "question_id": "q1",
      "question": "What is the security compliance policy?",
      "expected_output": "Quarterly audits.",
      "actual_output": "The policy requires quarterly audits...",
      "contexts": ["SOC2 Section 4.1..."],
      "doc_ids": ["doc_1"],
      "metrics": {
        "faithfulness": 0.95,
        "answer_relevance": 0.92
      }
    }
  ]
}
```
<!-- slide -->
```json
// --- NEW RESPONSE (NOW) ---
{
  "job_id": "job_12345",
  "status": "completed",
  "created_at": 1724700000.0,
  "completed_at": 1724700045.0,
  "cached": false,
  "summary": {
    "total_items": 1,
    "evaluation_time_seconds": 45.0,
    "p50_latency": 1.25,
    "p95_latency": 1.25,
    "total_tokens": 1200,
    "metrics": {
      "faithfulness": 0.95,
      "answer_relevancy": 0.92
    },
    "deepeval_evaluator_usage": {
      "prompt_tokens": 1500,
      "completion_tokens": 200,
      "total_tokens": 1700
    }
  },
  "results": [
    {
      "question_id": "q1",
      "user_input": "What is the security compliance policy?",
      "actual_input": "What is the security compliance policy for SOC2 access reviews?",
      "reference": "Quarterly audits.",
      "actual_output": "The policy requires quarterly audits...",
      "context": "SOC2 Section 4.1...",
      "retrieved_contexts": ["SOC2 Section 4.1..."],
      "expected_doc_ids": ["doc_1"],
      "retrieved_doc_ids": ["doc_1"],
      "latency": 1.25,
      "metrics": {
        "faithfulness": 0.95,
        "answer_relevancy": 0.92
      }
    }
  ]
}
```
````
