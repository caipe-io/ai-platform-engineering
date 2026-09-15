from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from deepeval_eval.datasets.enterprise import (
    EnterpriseDoc,
    EvalQuestion,
    parse_doc_filename,
)
from deepeval_eval.datasets.enterprise import (
    load_questions as load_enterprise_questions,
)
from deepeval_eval.datasets.enterprise import (
    select_questions as select_enterprise_questions,
)
from deepeval_eval.datasets.enterprise import (
    to_caipe_payload as enterprise_to_caipe_payload,
)
from deepeval_eval.datasets.enterprise import (
    write_corpus as write_enterprise_corpus,
)
from deepeval_eval.datasets.enterprise import (
    write_questions as write_enterprise_questions,
)
from deepeval_eval.datasets.hotpotqa import (
    load_document_pool,
    read_jsonl_zip,
    resolve_zip,
    unique,
)
from deepeval_eval.datasets.hotpotqa import (
    load_questions as load_hotpotqa_questions,
)
from deepeval_eval.datasets.hotpotqa import (
    select_documents as select_hotpotqa_documents,
)
from deepeval_eval.datasets.hotpotqa import (
    select_questions as select_hotpotqa_questions,
)
from deepeval_eval.datasets.hotpotqa import (
    to_caipe_payload as hotpotqa_to_caipe_payload,
)
from deepeval_eval.datasets.hotpotqa import (
    write_questions as write_hotpotqa_questions,
)
from deepeval_eval.datasets.loader import (
    DatabaseDataLoader,
    FileDataLoader,
    QuestionSetDataLoader,
)


def test_parse_doc_filename_positive() -> None:
    res = parse_doc_filename("folder/dsid_doc123__sample-title.txt")
    assert res == ("dsid_doc123", "sample title")


def test_parse_doc_filename_negative() -> None:
    assert parse_doc_filename("invalid_name.txt") is None
    assert parse_doc_filename("dsid_nodoubleunderscore.txt") is None
    assert parse_doc_filename("dsid_123__test.doc") is None


def test_enterprise_questions_positive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache_dir = tmp_path / "cache"
    questions_jsonl = (
        '{"question_id": "q1", "user_input": "What is X?", "reference": "X is Y", "category": "cat1", "source_types": ["slack"], "expected_doc_ids": ["doc1"]}\n'
        '{"question_id": "q2", "question": "Where is Z?", "gold_answer": "Z is here", "question_type": "cat2", "source_types": ["jira"], "expected_doc_ids": ["doc2"]}\n'
    )
    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.download_text",
        lambda url, dest: questions_jsonl,
    )

    q_list = load_enterprise_questions(cache_dir)
    assert len(q_list) == 2
    assert q_list[0].question_id == "q1"
    assert q_list[1].user_input == "Where is Z?"

    selected = select_enterprise_questions(
        q_list, source_types=["slack"], question_limit=1, questions_per_category=1
    )
    assert len(selected) == 1
    assert selected[0].question_id == "q1"


def test_enterprise_to_caipe_payload() -> None:
    doc = EnterpriseDoc(
        doc_id="d1", title="Title", text="Body text", source_type="slack"
    )
    payload = enterprise_to_caipe_payload(doc, datasource_id="ds1", ingestor_id="ing1")
    assert payload["page_content"] == "Body text"
    assert payload["metadata"]["document_id"] == "d1"


def test_fetch_documents(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from deepeval_eval.datasets.enterprise import fetch_documents

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "slack_slice_0001/dsid_doc999__first-doc.txt",
            "Doc Title\nBody text content",
        )

    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.download_bytes",
        lambda url, dest: buf.getvalue(),
    )
    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.SOURCE_SLICE_COUNTS", {"slack": 1}
    )

    docs = fetch_documents(
        source_types=["slack"],
        limit_per_source=5,
        cache_dir=tmp_path,
        reference_doc_ids={"dsid_doc999"},
    )
    assert len(docs) == 1
    assert docs[0].doc_id == "dsid_doc999"


def test_fetch_documents_deduplication_positive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from deepeval_eval.datasets.enterprise import fetch_documents

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "slack_slice_0001/dsid_doc1__first-doc.txt",
            "Identical Title\nDuplicate body content",
        )
        zf.writestr(
            "slack_slice_0001/dsid_doc2__second-doc.txt",
            "Identical Title\nDuplicate body content",
        )

    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.download_bytes",
        lambda url, dest: buf.getvalue(),
    )
    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.SOURCE_SLICE_COUNTS", {"slack": 1}
    )

    docs = fetch_documents(
        source_types=["slack"],
        limit_per_source=5,
        cache_dir=tmp_path,
        reference_doc_ids=set(),
    )
    # Even though there are 2 files, because their content is identical, deduplication keeps only 1
    assert len(docs) == 1
    assert docs[0].doc_id == "dsid_doc1"


def test_write_enterprise_files(tmp_path: Path) -> None:
    doc = EnterpriseDoc(
        doc_id="d1", title="Title", text="Body text", source_type="slack"
    )
    q = EvalQuestion(
        question_id="q1",
        user_input="Input",
        reference="Ref",
        category="cat",
        source_types=["slack"],
        expected_doc_ids=["d1"],
        answer_facts=[],
    )
    jsonl_p = tmp_path / "q.jsonl"
    csv_p = tmp_path / "q.csv"
    write_enterprise_questions([q], {"d1": doc}, jsonl_p, csv_p)
    assert jsonl_p.exists() and csv_p.exists()

    corpus_j = tmp_path / "c.jsonl"
    corpus_c = tmp_path / "c.csv"
    write_enterprise_corpus([doc], corpus_j, corpus_c)
    assert corpus_j.exists() and corpus_c.exists()


def test_unique_helper() -> None:
    assert unique(["a", "b", "a", "c", "b"]) == ["a", "b", "c"]
    assert unique([]) == []


def test_hotpotqa_dataset_helpers(tmp_path: Path) -> None:
    zip_path = tmp_path / "data.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        jsonl_data = '{"question_id": "hq1", "user_input": "What?", "reference": "Ans", "category": "catA", "expected_doc_ids": ["docA"]}\n'
        zf.writestr("items.jsonl", jsonl_data)
    zip_path.write_bytes(buf.getvalue())

    resolved = resolve_zip(zip_path)
    assert resolved == zip_path

    items = read_jsonl_zip(zip_path)
    assert len(items) == 1
    assert items[0]["question_id"] == "hq1"

    questions = load_hotpotqa_questions(zip_path)
    assert len(questions) == 1
    assert questions[0]["question_id"] == "hq1"

    selected_q = select_hotpotqa_questions(
        questions, limit=1, per_category=1, categories=None
    )
    assert len(selected_q) == 1

    pool_buf = io.BytesIO()
    with zipfile.ZipFile(pool_buf, "w") as zf:
        doc_jsonl = (
            '{"document_id": "docA", "title": "Doc A", "content": "Sample content"}\n'
        )
        zf.writestr("docs.jsonl", doc_jsonl)
    pool_zip = tmp_path / "pool.zip"
    pool_zip.write_bytes(pool_buf.getvalue())

    doc_pool = load_document_pool(pool_zip)
    assert "docA" in doc_pool

    selected_docs = select_hotpotqa_documents(
        questions, doc_pool, distractors_per_question=1, max_docs=5
    )
    assert len(selected_docs) == 1
    assert selected_docs[0]["document_id"] == "docA"

    payload = hotpotqa_to_caipe_payload(selected_docs[0], "ds", "ing")
    assert "Doc A\n\nSample content" in payload["page_content"]

    q_j = tmp_path / "hq.jsonl"
    q_c = tmp_path / "hq.csv"
    write_hotpotqa_questions(questions, doc_pool, q_j, q_c)
    assert q_j.exists() and q_c.exists()


def test_hotpotqa_fallbacks() -> None:
    from deepeval_eval.datasets.hotpotqa import select_documents, select_questions

    questions = [
        {"question_id": "q1", "category": "cat1", "expected_doc_ids": ["d1"]},
        {"question_id": "q2", "category": "cat1", "expected_doc_ids": ["d2"]},
    ]
    # Request limit=2 with per_category=1 to trigger fallback loop
    sel_q = select_questions(questions, limit=2, per_category=1, categories=None)
    assert len(sel_q) == 2

    pool = {
        "d1": {"document_id": "d1", "title": "T1", "text": "Text 1"},
        "d2": {"document_id": "d2", "title": "T2", "text": "Text 2"},
        "d3": {"document_id": "d3", "title": "T3", "text": "Text 3"},
    }
    # Request max_docs=3 to trigger filler loop in select_documents
    sel_d = select_documents(questions, pool, distractors_per_question=2, max_docs=3)
    assert len(sel_d) == 3


def test_hotpotqa_resolve_zip_negative(tmp_path: Path) -> None:
    non_existent = tmp_path / "non_existent.zip"
    with pytest.raises(FileNotFoundError):
        resolve_zip(non_existent)


def test_enterprise_select_questions_when_limit_zero_or_none_returns_all_matching_candidates() -> (
    None
):
    q1 = EvalQuestion("q1", "Q1", "A1", "cat1", ["confluence"], ["doc1"], [])
    q2 = EvalQuestion("q2", "Q2", "A2", "cat2", ["jira"], ["doc2"], [])
    q3 = EvalQuestion("q3", "Q3", "A3", "cat1", ["slack"], ["doc3"], [])

    res_none = select_enterprise_questions(
        [q1, q2, q3], source_types=["confluence", "jira"], question_limit=None
    )
    assert len(res_none) == 2

    res_zero = select_enterprise_questions(
        [q1, q2, q3], source_types=["confluence", "jira"], question_limit=0
    )
    assert len(res_zero) == 2


def test_enterprise_select_questions_when_per_category_cap_reached_fills_from_other_categories() -> (
    None
):
    q1 = EvalQuestion("q1", "Q1", "A1", "cat1", ["confluence"], ["d1"], [])
    q2 = EvalQuestion("q2", "Q2", "A2", "cat1", ["confluence"], ["d2"], [])
    q3 = EvalQuestion("q3", "Q3", "A3", "cat2", ["confluence"], ["d3"], [])

    # Limit is 3, questions_per_category=1. Pass 1 selects q1 (cat1) and q3 (cat2). Pass 2 fills q2 up to limit 3.
    selected = select_enterprise_questions(
        [q1, q2, q3],
        source_types=["confluence"],
        question_limit=3,
        questions_per_category=1,
    )
    assert len(selected) == 3
    assert [q.question_id for q in selected] == ["q1", "q3", "q2"]


def test_enterprise_fetch_documents_when_zip_contains_invalid_names_and_empty_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from deepeval_eval.datasets.enterprise import fetch_documents

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("slack_slice_0001/invalid_name.txt", "Some text")
        zf.writestr("slack_slice_0001/dsid_empty__empty-file.txt", "   \n  ")
        zf.writestr(
            "slack_slice_0001/dsid_valid__valid-doc.txt",
            "Valid Title\nValid content body",
        )

    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.download_bytes",
        lambda url, dest: buf.getvalue(),
    )
    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.SOURCE_SLICE_COUNTS", {"slack": 1}
    )

    docs = fetch_documents(
        source_types=["slack"],
        limit_per_source=5,
        cache_dir=tmp_path,
        reference_doc_ids=set(),
    )
    assert len(docs) == 1
    assert docs[0].doc_id == "dsid_valid"


def test_enterprise_prepare_bundle_and_ingestor_executes_successfully(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import argparse

    from deepeval_eval.datasets.enterprise import (
        EnterpriseDatasetIngestor,
    )

    q = EvalQuestion("q1", "Q1", "A1", "cat1", ["slack"], ["dsid_doc1"], [])
    doc = EnterpriseDoc("dsid_doc1", "Title", "Text", "slack")

    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.load_questions", lambda c: [q]
    )
    monkeypatch.setattr(
        "deepeval_eval.datasets.enterprise.fetch_documents",
        lambda s, limit_val, c, r: [doc],
    )

    args = argparse.Namespace(
        cache_dir=tmp_path,
        sources=["slack"],
        num_questions=1,
        questions_per_category=1,
        limit_per_source=1,
        datasource_id="ds_custom",
        datasource_name="Custom DS",
    )

    ingestor = EnterpriseDatasetIngestor()
    bundle = ingestor.prepare_bundle(args)
    assert bundle.datasource_id == "ds_custom"
    assert len(bundle.docs) == 1
    assert len(bundle.selected_questions) == 1


def test_hotpotqa_read_jsonl_zip_when_no_jsonl_raises_runtime_error(
    tmp_path: Path,
) -> None:
    zip_path = tmp_path / "empty.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("random.txt", "Hello world")
    zip_path.write_bytes(buf.getvalue())

    with pytest.raises(RuntimeError, match="No jsonl file found"):
        read_jsonl_zip(zip_path)


def test_hotpotqa_load_document_pool_when_doc_id_missing_skips_item(
    tmp_path: Path,
) -> None:
    zip_path = tmp_path / "docs_missing_id.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        jsonl = '{"title": "No ID Doc", "content": "Text"}\n{"document_id": "valid1", "content": "Valid"}\n'
        zf.writestr("docs.jsonl", jsonl)
    zip_path.write_bytes(buf.getvalue())

    pool = load_document_pool(zip_path)
    assert len(pool) == 1
    assert "valid1" in pool


def test_hotpotqa_select_questions_when_limit_zero_or_none_returns_all() -> None:
    questions = [
        {"question_id": "q1", "category": "cat1"},
        {"question_id": "q2", "category": "cat2"},
    ]
    assert len(select_hotpotqa_questions(questions, limit=None)) == 2
    assert len(select_hotpotqa_questions(questions, limit=0)) == 2


def test_hotpotqa_select_documents_when_target_reached_stops_iteration() -> None:
    questions = [{"expected_doc_ids": ["d1"]}]
    pool = {
        "d1": {"document_id": "d1", "title": "T1", "text": "Text 1"},
        "d2": {"document_id": "d2", "title": "T2", "text": "Text 2"},
        "d3": {"document_id": "d3", "title": "T3", "text": "Text 3"},
    }
    docs = select_hotpotqa_documents(
        questions, pool, distractors_per_question=0, max_docs=1
    )
    assert len(docs) == 1
    assert docs[0]["document_id"] == "d1"


def test_hotpotqa_prepare_bundle_and_ingestor_executes_successfully(
    tmp_path: Path,
) -> None:
    import argparse

    from deepeval_eval.datasets.hotpotqa import HotpotQADatasetIngestor, write_corpus

    q_zip = tmp_path / "q.zip"
    buf_q = io.BytesIO()
    with zipfile.ZipFile(buf_q, "w") as zf:
        zf.writestr(
            "questions.jsonl",
            '{"question_id": "hq1", "user_input": "Q", "reference": "A", "category": "c", "expected_doc_ids": ["hd1"]}\n',
        )
    q_zip.write_bytes(buf_q.getvalue())

    d_zip = tmp_path / "d.zip"
    buf_d = io.BytesIO()
    with zipfile.ZipFile(buf_d, "w") as zf:
        zf.writestr(
            "docs.jsonl",
            '{"document_id": "hd1", "title": "Doc1", "text": "Content1"}\n',
        )
    d_zip.write_bytes(buf_d.getvalue())

    args = argparse.Namespace(
        data_dir=tmp_path,
        questions_zip=q_zip,
        documents_zip=d_zip,
        limit=1,
        questions_per_category=1,
        categories=None,
        distractors_per_question=0,
        max_docs=1,
        datasource_id="hotpot_custom",
        datasource_name="Hotpot Custom",
    )

    ingestor = HotpotQADatasetIngestor()
    bundle = ingestor.prepare_bundle(args)
    assert bundle.datasource_id == "hotpot_custom"
    assert len(bundle.docs) == 1
    assert len(bundle.selected_questions) == 1

    # Also test write_corpus
    corpus_j = tmp_path / "hq_corpus.jsonl"
    corpus_c = tmp_path / "hq_corpus.csv"
    write_corpus(bundle.docs, corpus_j, corpus_c)
    assert corpus_j.exists() and corpus_c.exists()


def test_file_data_loader_load_json_with_limit_per_category_and_max_items(
    tmp_path: Path,
) -> None:
    json_path = tmp_path / "questions.json"
    data = [
        {"user_input": "Q1", "category": "cat1", "level": "hard"},
        {"user_input": "Q2", "category": "cat1", "level": "hard"},
        {"user_input": "Q3", "category": "cat1", "level": "easy"},
        "invalid_non_dict_item",
        {"user_input": "Q4", "category": "cat2", "level": "easy"},
    ]
    json_path.write_text(json.dumps(data), encoding="utf-8")

    loader = FileDataLoader(questions_file=json_path)

    # 1. limit_per_category without combine_with_level
    items = loader.load(limit_per_category=1)
    assert len(items) == 2
    assert [it["user_input"] for it in items] == ["Q1", "Q4"]

    # 2. limit_per_category with combine_with_level
    items_lvl = loader.load(limit_per_category=1, combine_with_level=True)
    assert len(items_lvl) == 3
    assert [it["user_input"] for it in items_lvl] == ["Q1", "Q3", "Q4"]

    # 3. max_items cut-off
    items_max = loader.load(max_items=2)
    assert len(items_max) == 2


def test_file_data_loader_load_csv_with_empty_expected_doc_ids(tmp_path: Path) -> None:
    csv_path = tmp_path / "questions.csv"
    csv_path.write_text(
        "user_input,expected_output,expected_doc_ids\nQ1,A1,\n", encoding="utf-8"
    )

    loader = FileDataLoader(questions_file=csv_path)
    items = loader.load()
    assert len(items) == 1
    assert items[0]["expected_doc_ids"] == []


def test_database_data_loader_load_raises_not_implemented_error() -> None:
    loader = DatabaseDataLoader(db_manager=MagicMock())
    with pytest.raises(
        NotImplementedError,
        match="Subclasses of DatabaseDataLoader must implement load",
    ):
        loader.load()


def test_question_set_data_loader_load_with_limit_per_category_and_level() -> None:
    mock_db = MagicMock()
    mock_qdb = MagicMock()
    mock_qdb.stream_questions.return_value = [
        {"input": "Q1", "expected_output": "A1", "category": "cat1", "level": "l1"},
        {"input": "Q2", "expected_output": "A2", "category": "cat1", "level": "l1"},
        {"input": "Q3", "expected_output": "A3", "category": "cat1", "level": "l2"},
        {"input": "Q4", "expected_output": "A4", "category": "cat2", "level": "l1"},
    ]

    with patch(
        "deepeval_eval.db.question_db_manager.QuestionDBManager", return_value=mock_qdb
    ):
        loader = QuestionSetDataLoader(question_set_id=1, db_manager=mock_db)

        # 1. limit_per_category without combine_with_level
        items = loader.load(limit_per_category=1)
        assert len(items) == 2
        assert [it["user_input"] for it in items] == ["Q1", "Q4"]

        # 2. limit_per_category with combine_with_level
        items_lvl = loader.load(limit_per_category=1, combine_with_level=True)
        assert len(items_lvl) == 3
        assert [it["user_input"] for it in items_lvl] == ["Q1", "Q3", "Q4"]
