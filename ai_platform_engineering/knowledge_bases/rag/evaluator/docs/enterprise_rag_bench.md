# EnterpriseRAG-Bench

This page documents the EnterpriseRAG-Bench workflow implemented in src/deepeval_eval/enterprise_deepeval.py and src/deepeval_eval/enterprise_dataset.py.

## Workflow Summary

EnterpriseRAG-Bench ingestion downloads the question set and source-specific document zip slices, selects a bounded local sample, ingests that sample into CAIPE, then evaluates CAIPE retrieval and context-grounded answer quality.

~~~mermaid
flowchart TD
    A[Download questions.jsonl] --> B[Select questions by source and category]
    B --> C[Collect expected document IDs]
    C --> D[Download source zip slices]
    D --> E[Prioritise expected docs]
    E --> F[Write corpus and questions to data]
    F --> G[Ingest documents into CAIPE]
    G --> H[Query CAIPE for each question]
    H --> I[Generate answer from contexts]
    I --> J[Run DeepEval and retrieval checks]
    J --> K[Write results]
~~~

## Input Sources

The code uses these constants in enterprise_dataset.py.

| Input | Source in code |
| --- | --- |
| Questions | https://raw.githubusercontent.com/onyx-dot-app/EnterpriseRAG-Bench/main/questions.jsonl |
| Documents | https://github.com/onyx-dot-app/EnterpriseRAG-Bench/releases/download/v1.0.0 |

The supported source types are:

~~~text
confluence jira github hubspot fireflies linear google_drive gmail slack
~~~

The repository stores downloaded files under cache when ingestion runs.

## Source Slice Counts

enterprise_dataset.py defines the number of zip slices per source.

| Source | Slice count |
| --- | ---: |
| confluence | 2 |
| jira | 2 |
| github | 2 |
| hubspot | 4 |
| fireflies | 3 |
| linear | 8 |
| google_drive | 6 |
| gmail | 25 |
| slack | 58 |

## Ingestion Process

The ingestion command performs these steps:

1. Load EnterpriseRAG-Bench questions.
2. Select questions matching requested source types.
3. Limit questions by total count and questions per category.
4. Collect expected document IDs from selected questions.
5. Download source zip slices.
6. Select up to the requested number of documents per source.
7. Place reference documents before filler documents where possible.
8. Register the ingestor in CAIPE.
9. Optionally reset the datasource when reset is requested.
10. Send document batches to CAIPE /v1/ingest.
11. Write generated corpus and question files to data.

## Default Ingestion Command

Wrapper command:

~~~powershell
.\scripts\ingest_enterprise.cmd
~~~

Direct command:

~~~powershell
python src\deepeval_eval\enterprise_deepeval.py ingest --sources confluence jira github hubspot fireflies linear google_drive gmail slack --limit-per-source 1000 --num-questions 10 --questions-per-category 3 --batch-size 50
~~~

Use reset only when the existing datasource should be cleared first:

~~~powershell
python src\deepeval_eval\enterprise_deepeval.py ingest --sources confluence jira github --limit-per-source 1000 --num-questions 10 --questions-per-category 3 --batch-size 50 --reset
~~~

## Ingestion Options

| Option | Default | Meaning |
| --- | --- | --- |
| --sources | confluence jira | Source types to include. Wrapper uses all supported sources. |
| --datasource-id | enterprise_rag_bench_deepeval | CAIPE datasource ID. |
| --datasource-name | EnterpriseRAG-Bench DeepEval | CAIPE datasource display name. |
| --limit-per-source | 1000 | Maximum selected documents per source. |
| --num-questions | 10 | Total selected evaluation questions. |
| --questions-per-category | 3 | Per-category cap during question selection. |
| --batch-size | 100 | Requested ingestion batch size. Wrapper uses 50. |
| --reset | false | Deletes the datasource before ingestion if present. |
| --skip-ingest | false | Writes local data files without sending documents to CAIPE. |

## Evaluation Process

The evaluation command:

1. Reads data/enterprise_deepeval_questions.jsonl.
2. Queries CAIPE /v1/query for each question.
3. Extracts retrieved context and source metadata.
4. Generates an answer from retrieved context.
5. Builds a DeepEval test case.
6. Runs DeepEval metrics.
7. Computes doc_id_recall and doc_id_precision.
8. Writes JSON and CSV results.

## Default Evaluation Command

Wrapper command:

~~~powershell
.\scripts\eval_enterprise.cmd
~~~

Direct command:

~~~powershell
python src\deepeval_eval\enterprise_deepeval.py eval --max-items 10 --top-k 3 --max-context-chars 6000
~~~

## Evaluation Options

| Option | Default in Python | Default in wrapper | Meaning |
| --- | --- | --- | --- |
| --datasource-id | enterprise_rag_bench_deepeval | enterprise_rag_bench_deepeval | CAIPE datasource filter. |
| --questions-file | data/enterprise_deepeval_questions.jsonl | same | Generated question file to evaluate. |
| --max-items | 3 | 10 | Maximum questions to evaluate. |
| --top-k | 5 | 3 | Number of contexts requested from CAIPE. |
| --max-context-chars | 16000 | 6000 | Per-context character limit before prompting. |
| --llm-base-url | None | None | Optional override for OPENAI_ENDPOINT. |
| --llm-api-key | None | None | Optional override for OPENAI_API_KEY. |
| --llm-model | None | None | Optional override for OPENAI_MODEL_NAME. |

## Expected Outputs

Ingestion writes:

~~~text
data/enterprise_deepeval_corpus.jsonl
data/enterprise_deepeval_corpus.csv
data/enterprise_deepeval_questions.jsonl
data/enterprise_deepeval_questions.csv
~~~

Evaluation writes:

~~~text
results/enterprise_deepeval_results_timestamp.json
results/enterprise_deepeval_results_timestamp.csv
~~~

The JSON result includes the question, reference answer, generated answer, retrieved source metadata, document ID scores, and DeepEval metric details.
