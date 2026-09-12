from __future__ import annotations

from pathlib import Path

import pytest

from deepeval_eval.datasets.loader import (
    DatabaseDataLoader,
    FileDataLoader,
    InMemoryDataLoader,
    QuestionSetDataLoader,
    resolve_questions_file,
)


def test_resolve_questions_file_explicit(tmp_path: Path):
    q_file = tmp_path / "custom_questions.jsonl"
    q_file.write_text('{"user_input": "test"}', encoding="utf-8")

    res = resolve_questions_file("custom", questions_file=q_file)
    assert res == q_file


def test_resolve_questions_file_by_convention(tmp_path: Path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    q_file = data_dir / "my_ds_questions.jsonl"
    q_file.write_text('{"user_input": "hello"}', encoding="utf-8")

    res = resolve_questions_file("my_ds", data_dir=data_dir)
    assert res == q_file


def test_resolve_questions_file_not_found(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        resolve_questions_file("nonexistent", data_dir=tmp_path)


def test_in_memory_data_loader():
    items = [
        {"user_input": "q1", "category": "cat1"},
        {"user_input": "q2", "category": "cat1"},
        {"user_input": "q3", "category": "cat2"},
    ]
    loader = InMemoryDataLoader(items)
    loaded = loader.load(max_items=2)
    assert len(loaded) == 2
    assert loaded[0]["user_input"] == "q1"

    limited = loader.load(limit_per_category=1)
    assert len(limited) == 2  # 1 from cat1, 1 from cat2


def test_file_data_loader(tmp_path: Path):
    q_file = tmp_path / "sample_questions.jsonl"
    q_file.write_text('{"user_input": "q1"}\n{"user_input": "q2"}\n', encoding="utf-8")

    loader = FileDataLoader(questions_file=q_file)
    rows = loader.load()
    assert len(rows) == 2
    assert rows[0]["user_input"] == "q1"


def test_file_data_loader_json(tmp_path: Path):
    q_file = tmp_path / "sample_questions.json"
    q_file.write_text('[{"user_input": "q1"}, {"user_input": "q2"}]', encoding="utf-8")

    loader = FileDataLoader(questions_file=q_file)
    rows = loader.load()
    assert len(rows) == 2
    assert rows[0]["user_input"] == "q1"


def test_database_data_loader_base():
    loader = DatabaseDataLoader(db_manager="mock_mgr", batch_size=500)
    assert loader.db_manager == "mock_mgr"
    assert loader.batch_size == 500
    with pytest.raises(NotImplementedError, match="Subclasses of DatabaseDataLoader"):
        loader.load()


def test_question_set_data_loader_inherits_database_data_loader():
    loader = QuestionSetDataLoader(question_set_id=1, db_manager="mock_mgr")
    assert isinstance(loader, DatabaseDataLoader)
    assert loader.question_set_id == 1
    assert loader.db_manager == "mock_mgr"
    assert loader.batch_size == 1000


def test_resolve_questions_file_explicit_nonexistent(tmp_path: Path):
    q_file = tmp_path / "nonexistent.jsonl"
    with pytest.raises(
        FileNotFoundError, match="Specified questions file does not exist"
    ):
        resolve_questions_file("custom", questions_file=q_file)


def test_file_data_loader_csv_and_limits(tmp_path: Path):
    csv_file = tmp_path / "questions.csv"
    csv_file.write_text(
        "question_id,category,level,user_input,expected_doc_ids\n"
        "q1,catA,L1,What is Python?,\"['doc1', 'doc2']\"\n"
        "q2,catA,L1,What is UV?,doc3\n"
        "q3,catA,L2,What is pytest?,\n"
        "q4,catB,L1,What is Docker?,doc4\n",
        encoding="utf-8",
    )

    loader = FileDataLoader(questions_file=csv_file)
    rows = loader.load(limit_per_category=1, combine_with_level=True)
    assert len(rows) == 3  # (catA, L1), (catA, L2), (catB, L1)
    assert rows[0]["expected_doc_ids"] == ["doc1", "doc2"]
    assert isinstance(rows[0]["expected_doc_ids"], list)

    rows_limited = loader.load(max_items=2)
    assert len(rows_limited) == 2


def test_file_data_loader_unsupported_format(tmp_path: Path):
    txt_file = tmp_path / "questions.txt"
    txt_file.write_text("user_input: q1\n", encoding="utf-8")

    loader = FileDataLoader(questions_file=txt_file)
    with pytest.raises(ValueError, match="Unsupported file format"):
        loader.load()


def test_file_data_loader_jsonl_limits(tmp_path: Path):
    jsonl_file = tmp_path / "questions.jsonl"
    jsonl_file.write_text(
        '{"category": "c1", "level": "l1", "user_input": "q1"}\n'
        "\n"
        '{"category": "c1", "level": "l1", "user_input": "q2"}\n'
        '{"category": "c1", "level": "l2", "user_input": "q3"}\n',
        encoding="utf-8",
    )
    loader = FileDataLoader(questions_file=jsonl_file)
    rows = loader.load(limit_per_category=1, combine_with_level=False)
    assert len(rows) == 1


def test_question_set_data_loader(monkeypatch):
    """Verify QuestionSetDataLoader streams questions from mocked QuestionDBManager."""
    from unittest.mock import MagicMock

    from deepeval_eval.datasets.loader import QuestionSetDataLoader

    mock_qdb = MagicMock()
    mock_qdb.stream_questions.return_value = [
        {
            "input": "What is Python?",
            "expected_output": "A programming language.",
            "category": "coding",
            "level": "basic",
            "expected_doc_ids": ["doc1"],
            "question_id": "q100",
        },
        {
            "input": "What is RAG?",
            "expected_output": "Retrieval Augmented Generation.",
            "category": "ai",
            "level": "intermediate",
            "expected_doc_ids": ["doc2"],
            "question_id": "q101",
        },
    ]

    # Use scoped monkeypatch context to patch QuestionDBManager strictly during load execution
    with monkeypatch.context() as m:
        m.setattr(
            "deepeval_eval.db.question_db_manager.QuestionDBManager",
            lambda db_mgr: mock_qdb,
        )
        loader = QuestionSetDataLoader(question_set_id=1, db_manager=MagicMock())
        rows = loader.load(max_items=1)
        assert len(rows) == 1
        assert rows[0]["user_input"] == "What is Python?"
        assert rows[0]["reference"] == "A programming language."
        assert rows[0]["category"] == "coding"
        assert rows[0]["question_id"] == "q100"


def test_max_items_zero(tmp_path: Path):
    """Verify passing max_items=0 returns an empty list across loaders."""
    q_file = tmp_path / "questions.jsonl"
    q_file.write_text('{"user_input": "q1"}\n{"user_input": "q2"}\n', encoding="utf-8")

    file_loader = FileDataLoader(questions_file=q_file)
    assert file_loader.load(max_items=0) == []

    mem_loader = InMemoryDataLoader([{"user_input": "q1"}, {"user_input": "q2"}])
    assert mem_loader.load(max_items=0) == []


def test_file_data_loader_csv_apostrophe_doc_ids(tmp_path: Path):
    """Verify CSV parser correctly handles doc IDs containing apostrophes via ast.literal_eval."""
    csv_file = tmp_path / "questions_apostrophe.csv"
    csv_file.write_text(
        "question_id,user_input,expected_doc_ids\n"
        "q1,Who is O'Brien?,\"['doc_O\\'Brien', 'doc2']\"\n",
        encoding="utf-8",
    )

    loader = FileDataLoader(questions_file=csv_file)
    rows = loader.load()
    assert len(rows) == 1
    assert rows[0]["expected_doc_ids"] == ["doc_O'Brien", "doc2"]


def test_question_set_data_loader_handles_question_and_user_input_aliases_without_error(
    monkeypatch,
):
    """Verify QuestionSetDataLoader gracefully normalizes rows containing both question and user_input without duplicating keys."""
    from unittest.mock import MagicMock

    from deepeval_eval.datasets.loader import QuestionSetDataLoader

    mock_qdb = MagicMock()
    mock_qdb.stream_questions.return_value = [
        {
            "question_id": "qst_101",
            "question": "What is the upload size limit?",
            "user_input": "What is the upload size limit?",
            "reference": "10 MiB limit",
            "expected_output": "10 MiB limit",
            "category": "api",
            "level": "L1",
            "expected_doc_ids": ["doc_limit"],
        }
    ]

    with monkeypatch.context() as m:
        m.setattr(
            "deepeval_eval.db.question_db_manager.QuestionDBManager",
            lambda db_mgr: mock_qdb,
        )
        loader = QuestionSetDataLoader(question_set_id=1, db_manager=MagicMock())
        rows = loader.load()
        assert len(rows) == 1
        assert rows[0]["user_input"] == "What is the upload size limit?"
        assert rows[0]["reference"] == "10 MiB limit"
        assert rows[0]["question_id"] == "qst_101"
