from __future__ import annotations

import csv
import json
import zipfile
from pathlib import Path
from typing import Any

from deepeval_eval.datasets.base import BaseDatasetIngestor, DatasetBundle

INGESTOR_TYPE = "hotpotqa"
INGESTOR_NAME = "hotpotqa"
DEFAULT_QUESTIONS_ZIP_NAME = "hotpotqa_full_questions.jsonl.zip"
DEFAULT_DOCUMENTS_ZIP_NAME = "hotpotqa_full_document_pool.jsonl.zip"
DEFAULT_CORPUS_JSONL_NAME = "hotpotqa_corpus.jsonl"
DEFAULT_CORPUS_CSV_NAME = "hotpotqa_corpus.csv"
DEFAULT_QUESTIONS_JSONL_NAME = "hotpotqa_questions.jsonl"
DEFAULT_QUESTIONS_CSV_NAME = "hotpotqa_questions.csv"


def resolve_zip(path: Path) -> Path:
    if path and path.exists():
        return path
    raise FileNotFoundError(f"Could not find zip file at {path}")


def read_jsonl_zip(path: Path) -> list[dict[str, Any]]:
    with zipfile.ZipFile(path) as zf:
        names = [name for name in zf.namelist() if name.endswith(".jsonl")]
        if not names:
            raise RuntimeError(f"No jsonl file found inside {path}")
        with zf.open(names[0]) as f:
            return [json.loads(line.decode("utf-8")) for line in f if line.strip()]


def unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def load_questions(path: Path) -> list[dict[str, Any]]:
    questions = []
    for item in read_jsonl_zip(path):
        questions.append(
            {
                "question_id": str(item.get("question_id") or ""),
                "user_input": str(item.get("user_input") or item.get("input") or ""),
                "reference": str(
                    item.get("reference") or item.get("expected_output") or ""
                ),
                "category": str(item.get("category") or "uncategorized"),
                "level": str(item.get("level") or ""),
                "expected_doc_ids": unique(
                    [str(v) for v in item.get("expected_doc_ids") or []]
                ),
                "source_types": list(item.get("source_types") or ["hotpotqa"]),
                "supporting_facts": list(item.get("supporting_facts") or []),
            }
        )
    return questions


def load_document_pool(path: Path) -> dict[str, dict[str, str]]:
    docs = {}
    for item in read_jsonl_zip(path):
        doc_id = str(item.get("document_id") or "")
        if not doc_id:
            continue
        docs[doc_id] = {
            "document_id": doc_id,
            "title": str(item.get("title") or doc_id),
            "text": str(item.get("content") or item.get("text") or ""),
        }
    return docs


def select_questions(
    questions: list[dict[str, Any]],
    limit: int | None = None,
    per_category: int | None = None,
    categories: list[str] | None = None,
) -> list[dict[str, Any]]:
    wanted = set(categories or [])
    candidates = [q for q in questions if not wanted or q["category"] in wanted]
    # If no limit is requested (or <= 0), return all matching candidate questions
    if not limit or limit <= 0:
        return candidates

    selected = []
    counts: dict[str, int] = {}
    for question in candidates:
        category = question["category"]
        if (
            per_category
            and per_category > 0
            and counts.get(category, 0) >= per_category
        ):
            continue
        selected.append(question)
        counts[category] = counts.get(category, 0) + 1
        if len(selected) >= limit:
            return selected
    seen = {q["question_id"] for q in selected}
    for question in candidates:
        if question["question_id"] in seen:
            continue
        selected.append(question)
        if len(selected) >= limit:
            break
    return selected


# Include supporting paragraphs first, then add distractors so retrieval has
# both relevant and irrelevant candidates to rank.
def select_documents(
    questions: list[dict[str, Any]],
    pool: dict[str, dict[str, str]],
    distractors_per_question: int,
    max_docs: int | None,
) -> list[dict[str, str]]:
    reference_ids = unique(
        [doc_id for q in questions for doc_id in q["expected_doc_ids"]]
    )
    docs = [pool[doc_id] for doc_id in reference_ids if doc_id in pool]
    target = max_docs or (len(docs) + len(questions) * distractors_per_question)
    target = max(target, len(docs))
    selected_ids = {doc["document_id"] for doc in docs}
    for doc in pool.values():
        if len(docs) >= target:
            break
        if doc["document_id"] in selected_ids:
            continue
        selected_ids.add(doc["document_id"])
        docs.append(doc)
    return docs


def to_caipe_payload(
    doc: dict[str, str], datasource_id: str, ingestor_id: str
) -> dict[str, Any]:
    title = doc.get("title", "")
    text = doc.get("text", "")
    return {
        "page_content": f"{title}\n\n{text}",
        "type": "Document",
        "metadata": {
            "document_id": doc["document_id"],
            "datasource_id": datasource_id,
            "ingestor_id": ingestor_id,
            "title": title,
            "description": "HotpotQA Wikipedia paragraph",
            "is_structured_entity": False,
            "document_type": "text",
            "document_ingested_at": None,
            "fresh_until": None,
            "metadata": {"source": "hotpotqa", "source_type": "hotpotqa"},
        },
    }


def write_corpus(docs: list[dict[str, str]], jsonl_path: Path, csv_path: Path) -> None:
    with (
        jsonl_path.open("w", encoding="utf-8") as jf,
        csv_path.open("w", encoding="utf-8", newline="") as cf,
    ):
        writer = csv.writer(cf)
        writer.writerow(["document_id", "title", "text"])
        for doc in docs:
            jf.write(json.dumps(doc, ensure_ascii=False) + "\n")
            writer.writerow([doc["document_id"], doc["title"], doc["text"]])


def write_questions(
    questions: list[dict[str, Any]],
    docs_by_id: dict[str, dict[str, str]],
    jsonl_path: Path,
    csv_path: Path,
) -> None:
    with (
        jsonl_path.open("w", encoding="utf-8") as jf,
        csv_path.open("w", encoding="utf-8", newline="") as cf,
    ):
        writer = csv.writer(cf)
        writer.writerow(
            [
                "question_id",
                "user_input",
                "reference",
                "category",
                "level",
                "expected_doc_ids",
            ]
        )
        for q in questions:
            context = [
                docs_by_id[doc_id]["text"]
                for doc_id in q["expected_doc_ids"]
                if doc_id in docs_by_id
            ]
            record = dict(q)
            record["context"] = context
            jf.write(json.dumps(record, ensure_ascii=False) + "\n")
            writer.writerow(
                [
                    q["question_id"],
                    q["user_input"],
                    q["reference"],
                    q["category"],
                    q["level"],
                    ";".join(q["expected_doc_ids"]),
                ]
            )


def prepare_hotpotqa_bundle(args: Any) -> DatasetBundle:
    """Prepare DatasetBundle for HotpotQA."""
    from deepeval_eval.core.config import DEFAULT_DATA_DIR

    data_dir = getattr(args, "data_dir", DEFAULT_DATA_DIR)
    questions_zip = resolve_zip(
        Path(
            getattr(args, "questions_zip", None)
            or (data_dir / DEFAULT_QUESTIONS_ZIP_NAME)
        )
    )
    documents_zip = resolve_zip(
        Path(
            getattr(args, "documents_zip", None)
            or (data_dir / DEFAULT_DOCUMENTS_ZIP_NAME)
        )
    )

    questions = load_questions(questions_zip)
    limit = getattr(args, "limit", None)
    questions_per_category = getattr(args, "questions_per_category", None)
    categories = getattr(args, "categories", None)
    selected = select_questions(questions, limit, questions_per_category, categories)
    print(f"Selected {len(selected)} questions")

    pool = load_document_pool(documents_zip)
    distractors_per_question = getattr(args, "distractors_per_question", 8)
    max_docs = getattr(args, "max_docs", None)
    docs = select_documents(selected, pool, distractors_per_question, max_docs)
    docs_by_id = {doc["document_id"]: doc for doc in docs}
    print(f"Selected {len(docs)} docs")

    covered = [
        q for q in selected if set(q["expected_doc_ids"]) <= set(docs_by_id.keys())
    ]
    if covered:
        selected = covered
    print(f"Questions fully covered by ingested docs: {len(covered)}")

    datasource_id = getattr(args, "datasource_id", None) or "hotpotqa"
    datasource_name = getattr(args, "datasource_name", None) or "HotpotQA"
    payloads = [to_caipe_payload(doc, datasource_id, INGESTOR_TYPE) for doc in docs]

    return DatasetBundle(
        datasource_id=datasource_id,
        datasource_name=datasource_name,
        ingestor_type=INGESTOR_TYPE,
        ingestor_name=INGESTOR_NAME,
        docs=docs,
        selected_questions=selected,
        docs_by_id=docs_by_id,
        payloads=payloads,
        corpus_jsonl_name=DEFAULT_CORPUS_JSONL_NAME,
        corpus_csv_name=DEFAULT_CORPUS_CSV_NAME,
        questions_jsonl_name=DEFAULT_QUESTIONS_JSONL_NAME,
        questions_csv_name=DEFAULT_QUESTIONS_CSV_NAME,
        write_corpus_fn=write_corpus,
        write_questions_fn=write_questions,
        job_description="HotpotQA DeepEval ingestion",
        datasource_description="HotpotQA sample for CAIPE DeepEval evaluation",
    )


class HotpotQADatasetIngestor(BaseDatasetIngestor):
    """Dataset ingestor handler for HotpotQA."""

    def prepare_bundle(self, args: Any) -> DatasetBundle:
        return prepare_hotpotqa_bundle(args)
