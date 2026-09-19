"""Dataset-agnostic ingestion pipeline for CAIPE evaluation benchmarks.

Provides a unified ingestion execution engine that dynamically resolves
and dispatches to registered dataset ingestors (e.g. EnterpriseRAG-Bench, HotpotQA).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.append(str(Path(__file__).resolve().parents[1]))

from deepeval_eval.clients.ingest_rag import IngestRagClient, build_ingest_rag_client
from deepeval_eval.core.config import (
    DEFAULT_CACHE_DIR,
    DEFAULT_DATA_DIR,
    DEFAULT_RESULTS_DIR,
    ensure_dirs,
    resolve_caipe_auth_token,
    resolve_caipe_base_url,
)
from deepeval_eval.datasets import get_dataset_ingestor
from deepeval_eval.datasets.base import DatasetBundle


def setup_ingest_client(args: argparse.Namespace) -> IngestRagClient:
    """Configure and instantiate IngestRagClient with CLI overrides."""
    from deepeval_eval.core.config import CaipeClientSettings

    rag_url = resolve_caipe_base_url(getattr(args, "rag_url", None))
    auth_token = resolve_caipe_auth_token(getattr(args, "auth_token", None))
    verify = not getattr(args, "insecure", False)

    settings = CaipeClientSettings(
        base_url=rag_url,
        auth_token=auth_token,
        insecure=not verify,
    )
    return build_ingest_rag_client(settings)


def ingest_payloads_to_caipe(
    client: IngestRagClient,
    datasource_id: str,
    datasource_name: str,
    ingestor_type: str,
    ingestor_name: str,
    payloads: list[dict[str, Any]],
    batch_size: int = 50,
    start_offset: int = 0,
    reset: bool = False,
    job_description: str = "Dataset ingestion",
    datasource_description: str = "Evaluation benchmark dataset for CAIPE",
) -> str:
    """Unified dataset-agnostic ingestion execution engine.

    Handles datasource resetting, ingestor registration, datasource upsert,
    job tracking, and offset-resumable batch ingestion with exponential backoff.
    """
    if reset:
        print(f"Resetting datasource {datasource_id}")
        client.reset_datasource(datasource_id)

    ingestor_id, max_docs_per_batch = client.register_ingestor(
        ingestor_type, ingestor_name, job_description
    )
    effective_batch_size = min(batch_size, max_docs_per_batch)

    client.upsert_datasource(
        datasource_id=datasource_id,
        name=datasource_name,
        ingestor_id=ingestor_id,
        description=datasource_description,
        source_type=ingestor_type,
    )

    offset = max(0, start_offset)
    remaining = payloads[offset:]
    job_id = client.open_job(datasource_id, len(remaining), job_description)
    print(
        f"Ingestion job opened: {job_id} (resuming from offset {offset}/{len(payloads)})"
    )

    for start in range(offset, len(payloads), effective_batch_size):
        batch = payloads[start : start + effective_batch_size]
        client.ingest_batch(batch, ingestor_id, datasource_id, job_id)
        print(f"  ingested {start + len(batch)}/{len(payloads)} documents")

    client.close_job(job_id, f"{job_description} complete")
    print("Ingestion job completed")
    return job_id


def execute_ingestion_pipeline(bundle: DatasetBundle, args: argparse.Namespace) -> None:
    """Unified runner for CAIPE ingestion and local artifact generation."""
    data_dir = getattr(args, "data_dir", DEFAULT_DATA_DIR)
    cache_dir = getattr(args, "cache_dir", DEFAULT_CACHE_DIR)
    results_dir = getattr(args, "results_dir", DEFAULT_RESULTS_DIR)
    ensure_dirs(data_dir, cache_dir, results_dir)

    if not getattr(args, "skip_ingest", False):
        client = setup_ingest_client(args)
        ingest_payloads_to_caipe(
            client=client,
            datasource_id=bundle.datasource_id,
            datasource_name=bundle.datasource_name,
            ingestor_type=bundle.ingestor_type,
            ingestor_name=bundle.ingestor_name,
            payloads=bundle.payloads,
            batch_size=getattr(args, "batch_size", 50),
            start_offset=getattr(args, "start_offset", 0),
            reset=getattr(args, "reset", False),
            job_description=bundle.job_description,
            datasource_description=bundle.datasource_description,
        )

    corpus_jsonl_path = Path(
        getattr(args, "corpus_jsonl", None) or (data_dir / bundle.corpus_jsonl_name)
    )
    corpus_csv_path = Path(
        getattr(args, "corpus_csv", None) or (data_dir / bundle.corpus_csv_name)
    )
    questions_jsonl_path = Path(
        getattr(args, "questions_file", None)
        or getattr(args, "questions_jsonl", None)
        or (data_dir / bundle.questions_jsonl_name)
    )
    questions_csv_path = Path(
        getattr(args, "questions_csv", None) or (data_dir / bundle.questions_csv_name)
    )

    bundle.write_corpus_fn(bundle.docs, corpus_jsonl_path, corpus_csv_path)
    bundle.write_questions_fn(
        bundle.selected_questions,
        bundle.docs_by_id,
        questions_jsonl_path,
        questions_csv_path,
    )
    print(f"Wrote data files to {data_dir}")


def run_ingest(args: argparse.Namespace) -> None:
    """Dynamically resolve dataset ingestor class and execute ingestion pipeline."""
    dataset_name = getattr(args, "dataset_name", None) or getattr(
        args, "benchmark", "enterprise"
    )
    ingestor = get_dataset_ingestor(dataset_name)
    bundle = ingestor.prepare_bundle(args)
    execute_ingestion_pipeline(bundle, args)


def build_parser() -> argparse.ArgumentParser:
    """Build argument parser for standalone dataset ingestion CLI."""
    parser = argparse.ArgumentParser(
        description="Dataset ingestion CLI for CAIPE evaluation benchmarks",
    )
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS_DIR)

    parser.add_argument(
        "--dataset-name",
        "--dataset",
        "--benchmark",
        dest="dataset_name",
        default="enterprise",
        help="Dataset name to ingest (default: enterprise)",
    )
    parser.add_argument("--rag-url", default=None)
    parser.add_argument("--auth-token", default=None)
    parser.add_argument("--datasource-id", default=None)
    parser.add_argument("--datasource-name", default=None)
    parser.add_argument("--sources", nargs="+", default=None)
    parser.add_argument("--limit-per-source", type=int, default=1000)
    parser.add_argument("--num-questions", type=int, default=None)
    parser.add_argument("--questions-per-category", type=int, default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--distractors-per-question", type=int, default=8)
    parser.add_argument("--max-docs", type=int, default=None)
    parser.add_argument("--questions-zip", type=Path, default=None)
    parser.add_argument("--documents-zip", type=Path, default=None)
    parser.add_argument("--corpus-jsonl", type=Path, default=None)
    parser.add_argument("--corpus-csv", type=Path, default=None)
    parser.add_argument(
        "--questions-jsonl",
        "--questions-file",
        type=Path,
        dest="questions_jsonl",
        default=None,
    )
    parser.add_argument("--questions-csv", type=Path, default=None)
    parser.add_argument("--categories", nargs="+", default=None)
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument(
        "--start-offset",
        "--resume-from",
        dest="start_offset",
        type=int,
        default=0,
        help="Document index offset to resume ingestion from (default: 0)",
    )
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--skip-ingest", action="store_true")
    parser.add_argument(
        "-k",
        "--insecure",
        action="store_true",
        help="Disable SSL certificate verification",
    )

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    run_ingest(args)


if __name__ == "__main__":
    main()
