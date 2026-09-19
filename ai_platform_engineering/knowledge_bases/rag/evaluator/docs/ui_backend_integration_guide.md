# Evaluator API: UI-to-Backend Integration Guide

This document is the complete, comprehensive REST API reference and integration guide for frontend and UI developers integrating with the **DeepEval RAG Evaluator Service**.

---

## 1. Base Configuration & Authentication

- **Base URL**: Reverse-proxied via Next.js BFF (`/api/eval/...`) or direct service (`http://<evaluator-host>:8000`)
- **Authentication**: Bearer JWT token in authorization header:
  ```http
  Authorization: Bearer <oidc_jwt_token>
  ```
- **Content Types**: `application/json`, `multipart/form-data` (upload endpoints), `text/csv` (exports)

---

## 2. Comprehensive Endpoint Index

### Evaluation Execution & Jobs
| Method | Path | Summary | Success |
| :--- | :--- | :--- | :--- |
| `POST` | `/eval/jobs` | Submit new evaluation job with JSON body | `202 Accepted` |
| `POST` | `/eval/jobs/question-sets/{set_id}` | Submit evaluation against a stored question set | `202 Accepted` |
| `POST` | `/eval/jobs/upload` | Upload `.json`/`.jsonl`/`.csv` file and execute evaluation | `202 Accepted` |
| `GET` | `/jobs` | List recent evaluation jobs (with RBAC visibility filter) | `200 OK` |
| `GET` | `/jobs/{job_id}` | Get evaluation job execution status & metadata | `200 OK` |
| `PATCH`| `/jobs/{job_id}/visibility` | Update job visibility mode (`private`/`team`/`public`) | `200 OK` |

### Evaluation Results & Summary
| Method | Path | Summary | Success |
| :--- | :--- | :--- | :--- |
| `GET` | `/jobs/{job_id}/results` | Stream evaluation results & item breakdown (JSON/CSV) | `200 OK` |
| `GET` | `/jobs/{job_id}/summary` | Retrieve summary metadata and metrics (JSON/CSV) | `200 OK` |
| `POST` | `/jobs/{job_id}/save-db` | Manually persist completed job results to PostgreSQL | `200 OK` |
| `GET` | `/results/db` | Query recent evaluation experiment runs in DB | `200 OK` |
| `GET` | `/results/db/{run_id}` | Query detailed per-question results from DB run | `200 OK` |

### Dynamic Question Sets Management
| Method | Path | Summary | Success |
| :--- | :--- | :--- | :--- |
| `GET` | `/question-sets` | List stored question sets with pagination & search | `200 OK` |
| `POST` | `/question-sets` | Create a new question set | `201 Created` |
| `GET` | `/question-sets/{id}` | Get question set metadata & category distribution | `200 OK` |
| `PUT` | `/question-sets/{id}` | Update question set name, description, source format | `200 OK` |
| `DELETE`| `/question-sets/{id}` | Delete question set and associated questions | `204 No Content` |
| `GET` | `/question-sets/{id}/questions` | List questions in set (paginated, filtered) | `200 OK` |
| `POST` | `/question-sets/{id}/questions` | Batch add questions to a set | `201 Created` |
| `GET` | `/question-sets/{id}/questions/{qid}` | Get individual question | `200 OK` |
| `PUT` | `/question-sets/{id}/questions/{qid}` | Update individual question | `200 OK` |
| `DELETE`| `/question-sets/{id}/questions/{qid}` | Delete individual question | `204 No Content` |
| `POST` | `/question-sets/{id}/questions/batch-delete` | Batch delete questions by ID list | `200 OK` |
| `GET` | `/question-sets/{id}/export` | Export question set as JSON or JSONL stream | `200 OK` |
| `PATCH`| `/question-sets/{id}/visibility` | Update question set visibility mode | `200 OK` |

### Dynamic Metrics & Metric Sets Management
| Method | Path | Summary | Success |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/metrics` | List all available custom and builtin metrics | `200 OK` |
| `POST` | `/api/v1/metrics` | Create a new custom metric (G-Eval / LLM judge) | `201 Created` |
| `GET` | `/api/v1/metrics/builtins` | List builtin system metric definitions | `200 OK` |
| `GET` | `/api/v1/metrics/{name}` | Get details of a specific metric | `200 OK` |
| `PUT` | `/api/v1/metrics/{name}` | Update custom metric definition | `200 OK` |
| `DELETE`| `/api/v1/metrics/{name}` | Delete custom metric | `204 No Content` |
| `GET` | `/api/v1/metric-sets` | List metric preset bundles | `200 OK` |
| `POST` | `/api/v1/metric-sets` | Create a new metric set bundle | `201 Created` |
| `GET` | `/api/v1/metric-sets/{name}` | Get specific metric set details | `200 OK` |
| `PUT` | `/api/v1/metric-sets/{name}` | Update metric set bundle | `200 OK` |
| `DELETE`| `/api/v1/metric-sets/{name}` | Delete metric set bundle | `204 No Content` |

### Health & Telemetry
| Method | Path | Summary | Success |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthz` / `/livez` | Shallow Kubernetes liveness probe | `200 OK` |
| `GET` | `/readyz` | Readiness probe (DB & Job Manager check) | `200 OK` (or `503`) |
| `GET` | `/health` | Deep diagnostic health check | `200 OK` (or `503`) |
| `GET` | `/metrics` | Prometheus metrics scrape format | `200 OK` |

---

## 3. Complete Request & Response JSON for Every Endpoint

### 1. `POST /eval/jobs` (Submit Evaluation Job)
- **Request Body**:
```json
{
  "dataset_name": "enterprise",
  "metric_set": "rag_core",
  "metrics": ["faithfulness", "answer_relevancy"],
  "top_k": 3,
  "max_items": 5,
  "agentic": true,
  "force_rerun": false,
  "experiment_name": "prompt-v2-eval",
  "visibility": "team",
  "owner_team": "core-ai"
}
```
- **Response JSON (`202 Accepted`)**:
```json
{
  "job_id": "job_01JC8XYZ7890ABCDEF12345678",
  "status": "pending",
  "created_at": 1724700000.0,
  "completed_at": null,
  "cached": false,
  "eval_hash": "a1b2c3d4e5f6789012345678abcdef01",
  "config_args": {
    "dataset_name": "enterprise",
    "metric_set": "rag_core",
    "top_k": 3,
    "agentic": true,
    "experiment_name": "prompt-v2-eval"
  },
  "error": null,
  "user_info": {
    "subject": "user-123",
    "email": "dev@example.com",
    "username": "dev"
  }
}
```

---

### 2. `POST /eval/jobs/question-sets/{set_id}` (Submit Job for Stored Question Set)
- **Path Parameter**: `set_id` (integer, e.g. `1`)
- **Request Body (Optional overrides)**:
```json
{
  "metric_set": "rag_core",
  "top_k": 5,
  "agentic": true,
  "force_rerun": true
}
```
- **Response JSON (`202 Accepted`)**:
```json
{
  "job_id": "job_01JC8XYZ9999ABCDEF12345678",
  "status": "pending",
  "created_at": 1724700010.0,
  "completed_at": null,
  "cached": false,
  "eval_hash": "f9e8d7c6b5a4...",
  "config_args": {
    "question_set_id": 1,
    "dataset_name": "security-eval-set",
    "top_k": 5
  },
  "error": null,
  "user_info": {
    "email": "dev@example.com"
  }
}
```

---

### 3. `POST /eval/jobs/upload` (Upload Dataset & Run Eval)
- **Content-Type**: `multipart/form-data`
- **Form Fields**: `file` (File), `dataset_name` (string), `metric_set` (string), `top_k` (int), `force_rerun` (bool)
- **Response JSON (`202 Accepted`)**:
```json
{
  "job_id": "job_01JC8XYZ8888ABCDEF12345678",
  "status": "pending",
  "created_at": 1724700020.0,
  "completed_at": null,
  "cached": false,
  "eval_hash": "c3d4e5f67890...",
  "config_args": {
    "dataset_name": "uploaded_qa_benchmark",
    "top_k": 3,
    "agentic": true
  },
  "error": null
}
```

---

### 4. `GET /jobs` (List Recent Evaluation Jobs)
- **Query Parameters**: (None, auto-filtered by user's OpenFGA ReBAC permissions)
- **Response JSON (`200 OK`)**:
```json
[
  {
    "job_id": "job_01JC8XYZ7890ABCDEF12345678",
    "status": "completed",
    "created_at": 1724700000.0,
    "completed_at": 1724700045.0,
    "cached": false,
    "eval_hash": "a1b2c3d4e5f6...",
    "config_args": {
      "dataset_name": "enterprise",
      "metric_set": "rag_core"
    },
    "error": null,
    "user_info": {
      "email": "dev@example.com"
    }
  }
]
```

---

### 5. `GET /jobs/{job_id}` (Get Job Status)
- **Path Parameter**: `job_id` (string)
- **Response JSON (`200 OK`)**:
```json
{
  "job_id": "job_01JC8XYZ7890ABCDEF12345678",
  "status": "completed",
  "created_at": 1724700000.0,
  "completed_at": 1724700045.2,
  "cached": false,
  "eval_hash": "a1b2c3d4e5f6789012345678abcdef01",
  "config_args": {
    "dataset_name": "enterprise",
    "metric_set": "rag_core",
    "top_k": 3,
    "agentic": true
  },
  "error": null,
  "user_info": {
    "email": "dev@example.com"
  }
}
```

---

### 6. `PATCH /jobs/{job_id}/visibility` (Update Job Visibility)
- **Request Body**:
```json
{
  "visibility": "public",
  "owner_team": "core-ai"
}
```
- **Response JSON (`200 OK`)**:
```json
{
  "job_id": "job_01JC8XYZ7890ABCDEF12345678",
  "status": "completed",
  "created_at": 1724700000.0,
  "completed_at": 1724700045.2,
  "cached": false,
  "eval_hash": "a1b2c3d4e5f6...",
  "config_args": {
    "visibility": "public",
    "owner_team": "core-ai"
  }
}
```

---

### 7. `GET /jobs/{job_id}/results` (Full Evaluation Results)
- **Query Parameter**: `format=json` (default) or `format=csv`
- **Response JSON (`200 OK`)**:
```json
{
  "job_id": "job_01JC8XYZ7890ABCDEF12345678",
  "status": "completed",
  "created_at": 1724700000.0,
  "completed_at": 1724700045.2,
  "cached": false,
  "eval_hash": "a1b2c3d4e5f6789012345678abcdef01",
  "evaluation_time": 45.2,
  "config_args": {
    "dataset_name": "enterprise",
    "metric_set": "rag_core",
    "top_k": 3,
    "agentic": true
  },
  "summary": {
    "total_items": 1,
    "evaluation_time_seconds": 45.2,
    "p50_latency": 1.25,
    "p95_latency": 1.25,
    "total_tokens": 3665,
    "metrics": {
      "faithfulness": 0.95,
      "answer_relevancy": 0.92,
      "context_precision": 0.88,
      "retrieval_recall": 1.0
    },
    "failure_causes": {},
    "deepeval_evaluator_usage": {
      "evaluation_time_seconds": 45.2,
      "prompt_tokens": 28317,
      "completion_tokens": 3477,
      "total_tokens": 31794
    }
  },
  "results": [
    {
      "question_id": "q1",
      "category": "security",
      "level": "intermediate",
      "user_input": "What is the security compliance policy for SOC2?",
      "actual_input": "What is the security compliance policy for SOC2?",
      "reference": "Quarterly access reviews and annual third-party audits.",
      "actual_output": "The SOC2 compliance policy mandates quarterly access reviews and annual audits.",
      "context": "SOC2 section 4.1: Access controls and audit schedules.",
      "retrieved_contexts": [
        "SOC2 section 4.1: Access controls and audit schedules...",
        "Section 4.2: Backup retention requirements..."
      ],
      "expected_doc_ids": ["doc_sec_101"],
      "retrieved_doc_ids": ["doc_sec_101", "doc_sec_102"],
      "latency": 1.25,
      "metrics": {
        "faithfulness": 0.98,
        "answer_relevancy": 0.95,
        "context_precision": 0.90,
        "retrieval_recall": 1.0
      },
      "pipeline_usage": {
        "prompt_tokens": 512,
        "completion_tokens": 120,
        "total_tokens": 632
      },
      "failure_cause": null
    }
  ],
  "user_info": {
    "email": "dev@example.com"
  }
}
```

---

### 8. `GET /jobs/{job_id}/summary` (Evaluation Summary Only)
- **Response JSON (`200 OK`)**:
```json
{
  "job_id": "job_01JC8XYZ7890ABCDEF12345678",
  "status": "completed",
  "created_at": 1724700000.0,
  "completed_at": 1724700045.2,
  "cached": false,
  "eval_hash": "a1b2c3d4e5f6...",
  "evaluation_time": 45.2,
  "config_args": {
    "dataset_name": "enterprise",
    "metric_set": "rag_core"
  },
  "summary": {
    "total_items": 1,
    "evaluation_time_seconds": 45.2,
    "p50_latency": 1.25,
    "p95_latency": 1.25,
    "total_tokens": 3665,
    "metrics": {
      "faithfulness": 0.95,
      "answer_relevancy": 0.92,
      "context_precision": 0.88,
      "retrieval_recall": 1.0
    },
    "deepeval_evaluator_usage": {
      "evaluation_time_seconds": 45.2,
      "prompt_tokens": 28317,
      "completion_tokens": 3477,
      "total_tokens": 31794
    }
  }
}
```

---

### 9. `POST /jobs/{job_id}/save-db` (Persist Job Results to PostgreSQL)
- **Response JSON (`200 OK`)**:
```json
{
  "job_id": "job_01JC8XYZ7890ABCDEF12345678",
  "status": "success",
  "message": "Evaluation results successfully saved to PostgreSQL database"
}
```

---

### 10. `GET /results/db` (Query PostgreSQL Runs)
- **Query Parameter**: `limit=10`
- **Response JSON (`200 OK`)**:
```json
{
  "count": 1,
  "runs": [
    {
      "run_id": "run_01JC8ABCDEF",
      "dataset_name": "enterprise",
      "answer_mode": "generate",
      "evaluation_time": 45.2,
      "total_items": 10,
      "created_at": "2026-08-26T20:00:00Z",
      "summary": {
        "metrics": {
          "faithfulness": 0.95,
          "answer_relevancy": 0.92
        }
      }
    }
  ]
}
```

---

### 11. `GET /results/db/{run_id}` (Query Per-Question DB Results)
- **Path Parameter**: `run_id` (string)
- **Response JSON (`200 OK`)**:
```json
{
  "run_id": "run_01JC8ABCDEF",
  "count": 1,
  "results": [
    {
      "question_id": "q1",
      "user_input": "What is the security compliance policy for SOC2?",
      "reference": "Quarterly access reviews and annual third-party audits.",
      "actual_output": "The SOC2 compliance policy mandates quarterly access reviews.",
      "retrieved_contexts": ["SOC2 section 4.1: Access controls..."],
      "retrieved_doc_ids": ["doc_sec_101"],
      "expected_doc_ids": ["doc_sec_101"],
      "latency_sec": 1.25,
      "metrics": {
        "faithfulness": 0.98,
        "answer_relevancy": 0.95
      }
    }
  ]
}
```

---

### 12. `GET /question-sets` (List Question Sets)
- **Query Parameters**: `page=1`, `limit=20`, `query=security`
- **Response JSON (`200 OK`)**:
```json
{
  "items": [
    {
      "id": 1,
      "name": "Security Compliance QA",
      "description": "SOC2 and ISO27001 evaluation benchmark",
      "source_format": "jsonl",
      "created_at": "2026-08-20T10:00:00Z",
      "updated_at": "2026-08-26T18:00:00Z",
      "question_count": 25,
      "categories": {
        "security": 15,
        "compliance": 10
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20,
  "total_pages": 1
}
```

---

### 13. `POST /question-sets` (Create Question Set)
- **Request Body**:
```json
{
  "name": "Finance & Invoicing QA",
  "description": "Invoice processing and tax evaluation questions",
  "source_format": "jsonl",
  "visibility": "team",
  "owner_team": "finance-ai"
}
```
- **Response JSON (`201 Created`)**:
```json
{
  "id": 2,
  "name": "Finance & Invoicing QA",
  "description": "Invoice processing and tax evaluation questions",
  "source_format": "jsonl",
  "created_at": "2026-08-26T21:00:00Z",
  "updated_at": "2026-08-26T21:00:00Z",
  "question_count": 0,
  "categories": {}
}
```

---

### 14. `GET /question-sets/{id}` (Get Question Set Details)
- **Response JSON (`200 OK`)**:
```json
{
  "id": 1,
  "name": "Security Compliance QA",
  "description": "SOC2 and ISO27001 evaluation benchmark",
  "source_format": "jsonl",
  "created_at": "2026-08-20T10:00:00Z",
  "updated_at": "2026-08-26T18:00:00Z",
  "question_count": 25,
  "categories": {
    "security": 15,
    "compliance": 10
  }
}
```

---

### 15. `PUT /question-sets/{id}` (Update Question Set)
- **Request Body**:
```json
{
  "name": "Security Compliance Benchmark v2",
  "description": "Updated SOC2 2026 guidelines"
}
```
- **Response JSON (`200 OK`)**:
```json
{
  "id": 1,
  "name": "Security Compliance Benchmark v2",
  "description": "Updated SOC2 2026 guidelines",
  "source_format": "jsonl",
  "created_at": "2026-08-20T10:00:00Z",
  "updated_at": "2026-08-26T21:30:00Z",
  "question_count": 25,
  "categories": {
    "security": 25
  }
}
```

---

### 16. `DELETE /question-sets/{id}`
- **Response**: `204 No Content`

---

### 17. `GET /question-sets/{id}/questions` (List Questions in Set)
- **Query Parameters**: `page=1`, `limit=50`, `category=security`, `level=intermediate`
- **Response JSON (`200 OK`)**:
```json
{
  "items": [
    {
      "id": 101,
      "question_set_id": 1,
      "question_id": "q1",
      "input": "What is the security compliance policy for SOC2?",
      "expected_output": "Quarterly access reviews and annual third-party audits.",
      "category": "security",
      "level": "intermediate",
      "expected_doc_ids": ["doc_sec_101"],
      "context": "SOC2 section 4.1: Access controls and audit schedules.",
      "extra": {
        "supporting_facts": ["SOC2 standard §4.1"]
      },
      "created_at": "2026-08-20T10:00:00Z",
      "updated_at": "2026-08-26T18:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 50,
  "total_pages": 1
}
```

---

### 18. `POST /question-sets/{id}/questions` (Batch Add Questions)
- **Request Body**:
```json
[
  {
    "question_id": "q2",
    "input": "How are encryption keys rotated in AWS KMS?",
    "expected_output": "Automatic yearly rotation or manual on-demand rotation.",
    "category": "cloud",
    "level": "advanced",
    "expected_doc_ids": ["doc_kms_01"],
    "context": "KMS automatic key rotation occurs every 365 days.",
    "extra": {}
  }
]
```
- **Response JSON (`201 Created`)**:
```json
[
  {
    "id": 102,
    "question_set_id": 1,
    "question_id": "q2",
    "input": "How are encryption keys rotated in AWS KMS?",
    "expected_output": "Automatic yearly rotation or manual on-demand rotation.",
    "category": "cloud",
    "level": "advanced",
    "expected_doc_ids": ["doc_kms_01"],
    "context": "KMS automatic key rotation occurs every 365 days.",
    "extra": null,
    "created_at": "2026-08-26T21:40:00Z",
    "updated_at": "2026-08-26T21:40:00Z"
  }
]
```

---

### 19. `GET /question-sets/{id}/questions/{qid}` (Get Single Question)
- **Response JSON (`200 OK`)**:
```json
{
  "id": 101,
  "question_set_id": 1,
  "question_id": "q1",
  "input": "What is the security compliance policy for SOC2?",
  "expected_output": "Quarterly access reviews and annual third-party audits.",
  "category": "security",
  "level": "intermediate",
  "expected_doc_ids": ["doc_sec_101"],
  "context": "SOC2 section 4.1...",
  "extra": null,
  "created_at": "2026-08-20T10:00:00Z",
  "updated_at": "2026-08-26T18:00:00Z"
}
```

---

### 20. `PUT /question-sets/{id}/questions/{qid}` (Update Question)
- **Request Body**:
```json
{
  "expected_output": "Quarterly access reviews and annual independent SOC2 Type II audits.",
  "level": "expert"
}
```
- **Response JSON (`200 OK`)**:
```json
{
  "id": 101,
  "question_set_id": 1,
  "question_id": "q1",
  "input": "What is the security compliance policy for SOC2?",
  "expected_output": "Quarterly access reviews and annual independent SOC2 Type II audits.",
  "category": "security",
  "level": "expert",
  "expected_doc_ids": ["doc_sec_101"],
  "context": "SOC2 section 4.1...",
  "extra": null,
  "created_at": "2026-08-20T10:00:00Z",
  "updated_at": "2026-08-26T21:45:00Z"
}
```

---

### 21. `DELETE /question-sets/{id}/questions/{qid}`
- **Response**: `204 No Content`

---

### 22. `POST /question-sets/{id}/questions/batch-delete`
- **Request Body**: `[101, 102, 103]`
- **Response JSON (`200 OK`)**:
```json
{
  "deleted_count": 3
}
```

---

### 23. `GET /question-sets/{id}/export` (Stream Export)
- **Query Parameter**: `format=json` or `format=jsonl`
- **Response**: Streaming `application/json` array or `application/x-ndjson` lines.

---

### 24. `PATCH /question-sets/{id}/visibility`
- **Request Body**:
```json
{
  "visibility": "team",
  "owner_team": "core-ai"
}
```
- **Response JSON (`200 OK`)**:
```json
{
  "id": 1,
  "name": "Security Compliance QA",
  "description": "SOC2 and ISO27001 evaluation benchmark",
  "source_format": "jsonl",
  "question_count": 25,
  "categories": { "security": 25 }
}
```

---

### 25. `GET /api/v1/metrics` (List Metrics)
- **Response JSON (`200 OK`)**:
```json
{
  "count": 2,
  "metrics": [
    {
      "name": "faithfulness",
      "display_name": "Faithfulness",
      "description": "Measures whether the actual output is grounded in retrieved context.",
      "metric_type": "rag_triad",
      "threshold": 0.7,
      "is_builtin": true,
      "created_at": "2026-08-01T00:00:00Z",
      "updated_at": "2026-08-01T00:00:00Z"
    },
    {
      "name": "custom_clarity",
      "display_name": "Executive Clarity",
      "description": "Evaluates concise and non-technical language for executives.",
      "metric_type": "g_eval",
      "threshold": 0.8,
      "is_builtin": false,
      "created_at": "2026-08-25T14:00:00Z",
      "updated_at": "2026-08-25T14:00:00Z"
    }
  ]
}
```

---

### 26. `POST /api/v1/metrics` (Create Custom Metric)
- **Request Body**:
```json
{
  "name": "conciseness",
  "display_name": "Answer Conciseness",
  "description": "Evaluates if answer is under 3 sentences and direct.",
  "metric_type": "g_eval",
  "threshold": 0.8,
  "evaluation_params": ["input", "actual_output"],
  "criteria": "Score 1.0 if answer is direct and under 3 sentences. Deduct points for filler words."
}
```
- **Response JSON (`201 Created`)**:
```json
{
  "name": "conciseness",
  "display_name": "Answer Conciseness",
  "description": "Evaluates if answer is under 3 sentences and direct.",
  "metric_type": "g_eval",
  "threshold": 0.8,
  "is_builtin": false,
  "created_at": "2026-08-26T21:50:00Z",
  "updated_at": "2026-08-26T21:50:00Z"
}
```

---

### 27. `GET /api/v1/metrics/builtins` (List Builtin Metric Definitions)
- **Response JSON (`200 OK`)**:
```json
[
  {
    "name": "faithfulness",
    "display_name": "Faithfulness",
    "description": "Evaluates hallucination against retrieved context",
    "metric_type": "rag_triad",
    "default_threshold": 0.7,
    "requires_llm_judge": true
  },
  {
    "name": "answer_relevancy",
    "display_name": "Answer Relevancy",
    "description": "Evaluates if output directly addresses user question",
    "metric_type": "rag_triad",
    "default_threshold": 0.7,
    "requires_llm_judge": true
  }
]
```

---

### 28. `GET /api/v1/metrics/{name}` (Get Metric Details)
- **Response JSON (`200 OK`)**:
```json
{
  "name": "conciseness",
  "display_name": "Answer Conciseness",
  "description": "Evaluates if answer is under 3 sentences and direct.",
  "metric_type": "g_eval",
  "threshold": 0.8,
  "is_builtin": false,
  "created_at": "2026-08-26T21:50:00Z",
  "updated_at": "2026-08-26T21:50:00Z"
}
```

---

### 29. `PUT /api/v1/metrics/{name}` (Update Custom Metric)
- **Request Body**:
```json
{
  "threshold": 0.85,
  "description": "Updated conciseness threshold"
}
```
- **Response JSON (`200 OK`)**:
```json
{
  "name": "conciseness",
  "display_name": "Answer Conciseness",
  "description": "Updated conciseness threshold",
  "metric_type": "g_eval",
  "threshold": 0.85,
  "is_builtin": false,
  "created_at": "2026-08-26T21:50:00Z",
  "updated_at": "2026-08-26T21:55:00Z"
}
```

---

### 30. `DELETE /api/v1/metrics/{name}`
- **Response**: `204 No Content`

---

### 31. `GET /api/v1/metric-sets` (List Metric Sets)
- **Response JSON (`200 OK`)**:
```json
{
  "count": 1,
  "metric_sets": [
    {
      "name": "rag_core",
      "display_name": "RAG Core Triad",
      "description": "Standard faithfulness, relevancy, and context precision bundle",
      "visibility": "public",
      "owner_team": null,
      "metrics": [
        { "metric_name": "faithfulness", "custom_threshold": 0.8 },
        { "metric_name": "answer_relevancy", "custom_threshold": 0.75 }
      ],
      "created_at": "2026-08-01T00:00:00Z",
      "updated_at": "2026-08-01T00:00:00Z"
    }
  ]
}
```

---

### 32. `POST /api/v1/metric-sets` (Create Metric Set)
- **Request Body**:
```json
{
  "name": "security_bundle",
  "display_name": "Security & Compliance Bundle",
  "description": "Faithfulness and hallucination prevention",
  "visibility": "team",
  "owner_team": "core-ai",
  "metrics": [
    { "metric_name": "faithfulness", "custom_threshold": 0.95 },
    { "metric_name": "answer_relevancy", "custom_threshold": 0.90 }
  ]
}
```
- **Response JSON (`201 Created`)**:
```json
{
  "name": "security_bundle",
  "display_name": "Security & Compliance Bundle",
  "description": "Faithfulness and hallucination prevention",
  "visibility": "team",
  "owner_team": "core-ai",
  "metrics": [
    { "metric_name": "faithfulness", "custom_threshold": 0.95 },
    { "metric_name": "answer_relevancy", "custom_threshold": 0.90 }
  ],
  "created_at": "2026-08-26T21:58:00Z",
  "updated_at": "2026-08-26T21:58:00Z"
}
```

---

### 33. `GET /api/v1/metric-sets/{name}` (Get Metric Set)
- **Response JSON (`200 OK`)**:
```json
{
  "name": "security_bundle",
  "display_name": "Security & Compliance Bundle",
  "description": "Faithfulness and hallucination prevention",
  "visibility": "team",
  "owner_team": "core-ai",
  "metrics": [
    { "metric_name": "faithfulness", "custom_threshold": 0.95 },
    { "metric_name": "answer_relevancy", "custom_threshold": 0.90 }
  ],
  "created_at": "2026-08-26T21:58:00Z",
  "updated_at": "2026-08-26T21:58:00Z"
}
```

---

### 34. `PUT /api/v1/metric-sets/{name}` (Update Metric Set)
- **Request Body**:
```json
{
  "display_name": "Security & Compliance Strict Bundle",
  "metrics": [
    { "metric_name": "faithfulness", "custom_threshold": 0.98 }
  ]
}
```
- **Response JSON (`200 OK`)**:
```json
{
  "name": "security_bundle",
  "display_name": "Security & Compliance Strict Bundle",
  "description": "Faithfulness and hallucination prevention",
  "visibility": "team",
  "owner_team": "core-ai",
  "metrics": [
    { "metric_name": "faithfulness", "custom_threshold": 0.98 }
  ],
  "created_at": "2026-08-26T21:58:00Z",
  "updated_at": "2026-08-26T21:59:00Z"
}
```

---

### 35. `DELETE /api/v1/metric-sets/{name}`
- **Response**: `204 No Content`

---

### 36. `GET /health` (Deep Health Probe)
- **Response JSON (`200 OK` / `503 Unavailable`)**:
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime_seconds": 3600.5,
  "checks": {
    "job_manager": "connected",
    "database": "connected"
  }
}
```

---

### 37. `GET /readyz` (Readiness Probe)
- **Response JSON (`200 OK` / `503 Unavailable`)**:
```json
{
  "status": "ok",
  "checks": {
    "database": "connected",
    "job_manager": "connected"
  }
}
```

---

## 4. TypeScript Type Definitions for Frontend

```typescript
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ResourceVisibility = 'private' | 'team' | 'public';
export type AnswerMode = 'generate' | 'ground_truth';

export interface UserInfo {
  subject?: string;
  email?: string;
  username?: string;
  roles?: string[];
}

export interface EvaluationRequest {
  dataset_name?: string;
  question_set_id?: number | null;
  question_ids?: string[] | null;
  question_indices?: number[] | null;
  answer_mode?: AnswerMode;
  datasource_id?: string | null;
  search_tool_name?: string | null;
  fetch_tool_name?: string | null;
  prompt_style?: string | null;
  prompt_args?: Record<string, any>;
  max_items?: number | null;
  limit_per_category?: number | null;
  top_k?: number;
  max_context_chars?: number;
  llm_model?: string | null;
  metric_set?: string | null;
  metrics?: string[] | null;
  agentic?: boolean;
  agent_id?: string | null;
  fail_on_error?: boolean;
  oracle_retrieval?: boolean;
  gate?: boolean;
  force_rerun?: boolean;
  oracle_testing?: boolean;
  owner_team?: string | null;
  visibility?: ResourceVisibility;
  experiment_name?: string | null;
}

export interface JobResponse {
  job_id: string;
  status: JobStatus;
  created_at: number;
  completed_at?: number | null;
  cached: boolean;
  eval_hash: string;
  config_args: Record<string, any>;
  error?: string | null;
  user_info?: UserInfo | null;
}

export interface EvaluatorTokenUsage {
  evaluation_time_seconds: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface EvaluationSummary {
  total_items: number;
  evaluation_time_seconds: number;
  p50_latency: number;
  p95_latency: number;
  total_tokens: number;
  metrics: Record<string, number>;
  failure_causes?: Record<string, number>;
  deepeval_evaluator_usage?: EvaluatorTokenUsage;
}

export interface EvaluationItemResult {
  question_id: string;
  category?: string;
  level?: string;
  user_input: string;               // Original raw user question/query from dataset
  actual_input?: string;            // The actual formatted/enriched query sent by the evaluator to the agent or LLM (e.g. enriched prompt or prompt style template)
  reference?: string;               // Ground truth expected answer
  actual_output: string;            // LLM generated answer
  context?: string;                 // Target ground truth document context
  retrieved_contexts: string[];     // Actual context chunks retrieved
  expected_doc_ids?: string[];      // Expected document IDs
  retrieved_doc_ids?: string[];     // Retrieved document IDs
  latency: number;                  // Query latency in seconds
  metrics: Record<string, number>;  // Individual metric scores (0.0 to 1.0)
  pipeline_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  failure_cause?: string | null;
}

export interface EvaluationResultsResponse {
  job_id: string;
  status: JobStatus;
  created_at: number;
  completed_at?: number | null;
  cached: boolean;
  eval_hash: string;
  evaluation_time: number;
  config_args: Record<string, any>;
  summary: EvaluationSummary;
  results: EvaluationItemResult[];
  user_info?: UserInfo | null;
}
```
