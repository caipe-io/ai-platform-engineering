from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Any

from deepeval_eval.core.config import DEFAULT_DATA_DIR

if TYPE_CHECKING:
    from deepeval_eval.db.db_manager import DatabaseManager


def resolve_questions_file(
    dataset_name: str,
    data_dir: Path = DEFAULT_DATA_DIR,
    questions_file: Path | None = None,
) -> Path:
    """Resolve the questions dataset file path via explicit input or naming convention."""
    if questions_file is not None:
        resolved = Path(questions_file)
        if resolved.exists():
            return resolved
        raise FileNotFoundError(
            f"Specified questions file does not exist: {questions_file}"
        )

    import re

    safe_name = re.sub(r"[^\w\.-]", "_", dataset_name)
    candidates = [
        data_dir / f"{safe_name}_questions.jsonl",
        data_dir / f"{safe_name}.jsonl",
        data_dir / f"{safe_name}_questions.csv",
    ]

    for candidate in candidates:
        if candidate.exists():
            return candidate

    raise FileNotFoundError(
        f"No valid questions file found for dataset_name='{dataset_name}' in data_dir='{data_dir}'"
    )


class BaseDataLoader(ABC):
    """Abstract base class for evaluation dataset loaders."""

    @abstractmethod
    def load(
        self,
        max_items: int | None = None,
        limit_per_category: int | None = None,
        combine_with_level: bool = False,
    ) -> list[dict[str, Any]]:
        """Load evaluation questions as a list of dictionaries."""
        pass


class FileDataLoader(BaseDataLoader):
    """Data loader that reads evaluation question items from a JSONL or CSV file on disk."""

    def __init__(
        self,
        questions_file: Path | None = None,
        dataset_name: str = "enterprise",
        data_dir: Path = DEFAULT_DATA_DIR,
    ) -> None:
        self.dataset_name = dataset_name
        self.data_dir = data_dir
        self.questions_file = questions_file

    def resolve_file(self) -> Path:
        return resolve_questions_file(
            dataset_name=self.dataset_name,
            data_dir=self.data_dir,
            questions_file=self.questions_file,
        )

    def load(
        self,
        max_items: int | None = None,
        limit_per_category: int | None = None,
        combine_with_level: bool = False,
    ) -> list[dict[str, Any]]:
        if max_items == 0:
            return []
        path = self.resolve_file()
        rows: list[dict[str, Any]] = []
        category_counts: dict[tuple[str, str | None] | str, int] = {}

        if path.suffix == ".jsonl":
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    item = json.loads(line)
                    cat = item.get("category", "basic") or "basic"
                    if limit_per_category is not None:
                        key = (cat, item.get("level")) if combine_with_level else cat
                        count = category_counts.get(key, 0)
                        if count >= limit_per_category:
                            continue
                        category_counts[key] = count + 1
                    rows.append(item)
                    if max_items is not None and len(rows) >= max_items:
                        break
        elif path.suffix == ".json":
            with path.open("r", encoding="utf-8") as f:
                content = json.load(f)
                items = content if isinstance(content, list) else [content]
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    cat = item.get("category", "basic") or "basic"
                    if limit_per_category is not None:
                        key = (cat, item.get("level")) if combine_with_level else cat
                        count = category_counts.get(key, 0)
                        if count >= limit_per_category:
                            continue
                        category_counts[key] = count + 1
                    rows.append(item)
                    if max_items is not None and len(rows) >= max_items:
                        break
        elif path.suffix == ".csv":
            import csv

            with path.open("r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for item in reader:
                    cat = item.get("category", "basic") or "basic"
                    if limit_per_category is not None:
                        key = (cat, item.get("level")) if combine_with_level else cat
                        count = category_counts.get(key, 0)
                        if count >= limit_per_category:
                            continue
                        category_counts[key] = count + 1

                    row_dict = dict(item)
                    if "expected_doc_ids" in row_dict and isinstance(
                        row_dict["expected_doc_ids"], str
                    ):
                        raw_ids = row_dict["expected_doc_ids"].strip()
                        if raw_ids:
                            import ast

                            try:
                                parsed = ast.literal_eval(raw_ids)
                                row_dict["expected_doc_ids"] = (
                                    list(parsed)
                                    if isinstance(parsed, (list, tuple))
                                    else [str(parsed)]
                                )
                            except (ValueError, SyntaxError):
                                row_dict["expected_doc_ids"] = [
                                    d.strip()
                                    for d in raw_ids.strip("[]").split(",")
                                    if d.strip()
                                ]
                        else:
                            row_dict["expected_doc_ids"] = []

                    rows.append(row_dict)
                    if max_items is not None and len(rows) >= max_items:
                        break
        else:
            raise ValueError(
                f"Unsupported file format for evaluation questions: {path.suffix}"
            )

        return rows


class InMemoryDataLoader(BaseDataLoader):
    """Data loader that wraps an in-memory list of evaluation question dicts."""

    def __init__(self, dataset: list[dict[str, Any]]) -> None:
        self._dataset = dataset

    def load(
        self,
        max_items: int | None = None,
        limit_per_category: int | None = None,
        combine_with_level: bool = False,
    ) -> list[dict[str, Any]]:
        if max_items == 0:
            return []
        rows: list[dict[str, Any]] = []
        category_counts: dict[tuple[str, str | None] | str, int] = {}

        for item in self._dataset:
            cat = item.get("category", "basic") or "basic"
            if limit_per_category is not None:
                key = (cat, item.get("level")) if combine_with_level else cat
                count = category_counts.get(key, 0)
                if count >= limit_per_category:
                    continue
                category_counts[key] = count + 1
            rows.append(item)
            if max_items is not None and len(rows) >= max_items:
                break
        return rows


class DatabaseDataLoader(BaseDataLoader):
    """Base class for database-backed data loaders."""

    def __init__(
        self, db_manager: DatabaseManager | Any, batch_size: int = 1000
    ) -> None:
        self.db_manager = db_manager
        self.batch_size = batch_size

    def load(
        self,
        max_items: int | None = None,
        limit_per_category: int | None = None,
        combine_with_level: bool = False,
    ) -> list[dict[str, Any]]:
        raise NotImplementedError(
            "Subclasses of DatabaseDataLoader must implement load()."
        )


class QuestionSetDataLoader(DatabaseDataLoader):
    """Loads evaluation questions from PostgreSQL Question Sets by set ID."""

    def __init__(
        self,
        question_set_id: int,
        db_manager: DatabaseManager | Any,
        batch_size: int = 1000,
    ) -> None:
        super().__init__(db_manager=db_manager, batch_size=batch_size)
        self.question_set_id = question_set_id

    def load(
        self,
        max_items: int | None = None,
        limit_per_category: int | None = None,
        combine_with_level: bool = False,
    ) -> list[dict[str, Any]]:
        if max_items == 0:
            return []
        from deepeval_eval.db.question_db_manager import QuestionDBManager

        qdb = QuestionDBManager(self.db_manager)
        rows: list[dict[str, Any]] = []
        category_counts: dict[Any, int] = {}

        gen = qdb.stream_questions(self.question_set_id, batch_size=self.batch_size)
        try:
            for item in gen:
                user_input_val = (
                    item.get("input")
                    or item.get("user_input")
                    or item.get("question")
                    or ""
                )
                expected_out_val = (
                    item.get("expected_output") or item.get("reference") or ""
                )
                mapped = {
                    "user_input": user_input_val,
                    "reference": expected_out_val,
                    "category": item.get("category") or "basic",
                    "level": item.get("level"),
                    "expected_doc_ids": item.get("expected_doc_ids") or [],
                    "context": item.get("context"),
                    "question_id": item.get("question_id"),
                }
                cat = mapped["category"]
                if limit_per_category is not None:
                    key = (cat, mapped["level"]) if combine_with_level else cat
                    count = category_counts.get(key, 0)
                    if count >= limit_per_category:
                        continue
                    category_counts[key] = count + 1
                rows.append(mapped)
                if max_items is not None and len(rows) >= max_items:
                    break
        finally:
            if hasattr(gen, "close"):
                gen.close()
        return rows
