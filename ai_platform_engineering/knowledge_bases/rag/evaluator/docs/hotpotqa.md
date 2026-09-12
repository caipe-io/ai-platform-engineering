# HotpotQA

This page documents the HotpotQA workflow implemented in src/deepeval_eval/hotpotqa_deepeval.py and src/deepeval_eval/hotpotqa_dataset.py.

## Workflow Summary

HotpotQA uses preprocessed zip files rather than downloading directly from the benchmark source. The pipeline reads the preprocessed question set and document pool, builds a bounded sample, ingests documents into CAIPE, and evaluates retrieval plus short-answer quality.

~~~mermaid
flowchart TD
    A[Read preprocessed question zip] --> B[Read preprocessed document pool zip]
    B --> C[Select questions]
    C --> D[Select gold docs and distractors]
    D --> E[Write corpus and question files]
    E --> F[Ingest documents into CAIPE]
    F --> G[Query CAIPE]
    G --> H[Generate short answer]
    H --> I[Run DeepEval metrics]
    I --> J[Run exact and contains checks]
    J --> K[Write results]
~~~

## Dataset Preparation

The code expects these files:

~~~text
cache/hotpotqa_full_questions.jsonl.zip
cache/hotpotqa_full_document_pool.jsonl.zip
~~~

If those files are not present in cache, hotpotqa_dataset.py falls back to ~/Downloads.

How the zip files are originally produced is outside the current repository and is to be confirmed.

## Input Fields

The question loader reads these fields when present:

| Field | Use |
| --- | --- |
| question_id | Stable question identifier. |
| user_input or input | Question text sent to CAIPE. |
| reference or expected_output | Expected answer. |
| category | HotpotQA category such as bridge or comparison. |
| level | Difficulty label. |
| expected_doc_ids | Gold document IDs for retrieval checks. |
| source_types | Source type list, defaulting to hotpotqa. |
| supporting_facts | Supporting fact metadata. |

The document pool loader reads:

| Field | Use |
| --- | --- |
| document_id | CAIPE document ID and retrieval reference. |
| title | Document title. |
| content or text | Document body. |

## Ingestion Process

The ingestion command performs these steps:

1. Resolve the question zip file.
2. Resolve the document pool zip file.
3. Load questions from JSONL inside the zip.
4. Select questions by limit, per-category cap, and optional categories.
5. Select expected documents first.
6. Add distractor documents up to the target document count.
7. Register the ingestor in CAIPE.
8. Optionally reset the datasource.
9. Send document batches to CAIPE.
10. Write generated corpus and question files to data.

## Default Ingestion Command

Wrapper command:

~~~powershell
.\scripts\ingest_hotpotqa.cmd
~~~

Direct command:

~~~powershell
python src\deepeval_eval\hotpotqa_deepeval.py ingest --limit 100 --questions-per-category 50 --max-docs 1000 --batch-size 50
~~~

Use reset only when the existing datasource should be cleared first:

~~~powershell
python src\deepeval_eval\hotpotqa_deepeval.py ingest --limit 100 --questions-per-category 50 --max-docs 1000 --batch-size 50 --reset
~~~

## Ingestion Options

| Option | Default | Meaning |
| --- | --- | --- |
| --questions-zip | cache/hotpotqa_full_questions.jsonl.zip | Preprocessed questions zip. |
| --documents-zip | cache/hotpotqa_full_document_pool.jsonl.zip | Preprocessed document pool zip. |
| --datasource-id | hotpotqa_deepeval | CAIPE datasource ID. |
| --datasource-name | HotpotQA DeepEval | CAIPE datasource display name. |
| --limit | 100 | Maximum selected questions. |
| --questions-per-category | 50 | Per-category cap. |
| --categories | None | Optional filter. Choices are bridge and comparison. |
| --distractors-per-question | 8 | Extra distractor target when max docs is not set. |
| --max-docs | None | Maximum selected documents. Wrapper uses 1000. |
| --batch-size | 50 | Requested ingestion batch size. |
| --reset | false | Deletes the datasource before ingestion if present. |
| --skip-ingest | false | Writes local data files without sending documents to CAIPE. |

## Evaluation Process

The evaluation command:

1. Reads data/hotpotqa_deepeval_questions.jsonl.
2. Queries CAIPE /v1/query for each question.
3. Extracts retrieved context and source metadata.
4. Generates a short answer from retrieved context.
5. Runs DeepEval metrics.
6. Computes doc_id_recall and doc_id_precision.
7. Computes answer_exact_match and answer_contains_reference.
8. Writes JSON and CSV results.

## Default Evaluation Command

Wrapper command:

~~~powershell
.\scripts\eval_hotpotqa.cmd
~~~

Direct command:

~~~powershell
python src\deepeval_eval\hotpotqa_deepeval.py eval --max-items 10 --top-k 5 --max-context-chars 12000
~~~

## Expected Outputs

Ingestion writes:

~~~text
data/hotpotqa_deepeval_corpus.jsonl
data/hotpotqa_deepeval_corpus.csv
data/hotpotqa_deepeval_questions.jsonl
data/hotpotqa_deepeval_questions.csv
~~~

Evaluation writes:

~~~text
results/hotpotqa_deepeval_results_timestamp.json
results/hotpotqa_deepeval_results_timestamp.csv
~~~

## Difference From EnterpriseRAG-Bench

| Area | EnterpriseRAG-Bench | HotpotQA |
| --- | --- | --- |
| Dataset loading | Downloads questions and source zip slices from public URLs. | Reads preprocessed local zip files. |
| Source types | Multiple enterprise-style source types. | Single source type hotpotqa. |
| Document selection | Limits documents per source and prioritises expected docs. | Selects expected docs first, then distractors. |
| Answer style | General context-grounded answer. | Short answer prompt. |
| Extra checks | Document ID recall and precision. | Document ID recall, precision, exact match, and contains reference. |
