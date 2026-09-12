from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from deepeval_eval.db.db_manager import DatabaseManager
from deepeval_eval.db.evaluation_db_manager import EvaluationDBManager
from deepeval_eval.db.question_db_manager import QuestionDBManager

# ---------------------------------------------------------------------------
# Unit Tests for QuestionDBManager (Direct Database Methods)
# ---------------------------------------------------------------------------


def test_question_db_manager_init_tables_non_postgres():
    """Verify init_tables returns early when PostgreSQL is not configured."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = False

    manager = QuestionDBManager(mock_base_db)
    manager.init_tables()

    mock_base_db.get_connection.assert_not_called()


def test_question_db_manager_init_tables_positive():
    """Verify init_tables executes schema creation SQL statements on PostgreSQL connection."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = True

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    manager.init_tables()

    assert mock_cur.execute.called
    mock_conn.commit.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_create_question_set_positive():
    """Verify create_question_set inserts record and returns formatted dictionary."""
    mock_base_db = MagicMock(spec=DatabaseManager)

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (
        1,
        "Enterprise RAG Bench",
        "Test dataset description",
        "jsonl",
        MagicMock(isoformat=lambda: "2026-08-02T00:00:00+00:00"),
        MagicMock(isoformat=lambda: "2026-08-02T00:00:00+00:00"),
        "hash123456",
    )
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.create_question_set(
        name="Enterprise RAG Bench",
        description="Test dataset description",
        source_format="jsonl",
        content_hash="hash123456",
    )

    assert res["id"] == 1
    assert res["name"] == "Enterprise RAG Bench"
    assert res["description"] == "Test dataset description"
    assert res["source_format"] == "jsonl"
    assert res["content_hash"] == "hash123456"
    assert res["question_count"] == 0
    mock_conn.commit.assert_called_once()


def test_question_db_manager_find_by_content_hash_positive():
    """Verify find_by_content_hash returns matching question set when found."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.side_effect = [
        (
            1,
            "Enterprise RAG Bench",
            "Test description",
            "json",
            MagicMock(isoformat=lambda: "2026-08-02T00:00:00+00:00"),
            MagicMock(isoformat=lambda: "2026-08-02T00:00:00+00:00"),
            "hash_abcdef",
        ),
        (5,),
    ]
    mock_cur.fetchall.return_value = [("basic", 5)]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.find_by_content_hash("hash_abcdef")

    assert res is not None
    assert res["id"] == 1
    assert res["name"] == "Enterprise RAG Bench"
    assert res["content_hash"] == "hash_abcdef"
    assert res["question_count"] == 5


def test_question_db_manager_find_by_content_hash_negative():
    """Verify find_by_content_hash returns None when no matching content_hash is found."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.find_by_content_hash("nonexistent_hash")

    assert res is None


def test_question_db_manager_get_question_set_negative():
    """Verify get_question_set returns None for non-existent set ID."""
    mock_base_db = MagicMock(spec=DatabaseManager)

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.get_question_set(set_id=999)

    assert res is None


def test_question_db_manager_update_question_set_negative():
    """Verify update_question_set returns None when target set_id does not exist."""
    mock_base_db = MagicMock(spec=DatabaseManager)

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.update_question_set(set_id=999, name="Non-existent")

    assert res is None


def test_question_db_manager_delete_question_set_negative():
    """Verify delete_question_set returns False when deleting non-existent set ID."""
    mock_base_db = MagicMock(spec=DatabaseManager)

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    success = manager.delete_question_set(set_id=999)

    assert success is False


def test_question_db_manager_add_questions_negative_non_existent_set():
    """Verify add_questions raises ValueError when set_id does not exist."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with pytest.raises(ValueError, match="does not exist"):
        manager.add_questions(set_id=999, questions_data=[{"input": "Test"}])


def test_question_db_manager_add_questions_negative_missing_input():
    """Verify add_questions raises ValueError when question item lacks input field."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (1,)
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with pytest.raises(ValueError, match="missing required field 'input'"):
        manager.add_questions(set_id=1, questions_data=[{"category": "test"}])


def test_question_db_manager_get_question_negative():
    """Verify get_question_by_id returns None for non-existent question identifier."""
    mock_base_db = MagicMock(spec=DatabaseManager)

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.get_question_by_id(set_id=1, id=999)

    assert res is None


def test_question_db_manager_batch_delete_questions_negative_empty():
    """Verify batch_delete_questions returns 0 when empty list of identifiers is provided."""
    mock_base_db = MagicMock(spec=DatabaseManager)

    manager = QuestionDBManager(mock_base_db)
    assert manager.batch_delete_questions(set_id=1, ids=[]) == 0


def test_question_db_manager_batch_delete_questions_by_ids_positive():
    """Verify batch_delete_questions executes correct query for integer PKs."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchall.return_value = [(1,), (2,)]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    count = manager.batch_delete_questions(set_id=10, ids=[1, 2])

    assert count == 2
    executed_sql = mock_cur.execute.call_args_list[0][0][0]
    assert "id = ANY(%s)" in executed_sql
    assert "WHERE question_set_id = %s" in executed_sql


def test_question_db_manager_batch_delete_oversized_payload_raises_value_error():
    """Verify batch_delete_questions raises ValueError when payload exceeds 1000 items."""
    import pytest

    mock_base_db = MagicMock(spec=DatabaseManager)
    manager = QuestionDBManager(mock_base_db)

    oversized_ids = list(range(1001))
    with pytest.raises(
        ValueError,
        match="Batch delete payload exceeds limit of 1,000 items",
    ):
        manager.batch_delete_questions(set_id=1, ids=oversized_ids)


def test_list_question_sets_escapes_like_wildcards():
    """Verify list_question_sets escapes LIKE wildcards % and _ in query."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (0,)
    mock_cur.fetchall.return_value = []
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.list_question_sets(query="%admin_set%")
    assert res["total"] == 0

    executed_sqls = [call[0][0] for call in mock_cur.execute.call_args_list]
    executed_params = [call[0][1] for call in mock_cur.execute.call_args_list]

    assert any("ESCAPE" in sql for sql in executed_sqls)
    assert any(
        r"\%admin\_set\%" in p
        for params in executed_params
        for p in params
        if isinstance(p, str)
    )


def test_list_question_sets_allowed_ids_provided_filters_matching_items():
    """Verify list_question_sets filters by allowed_ids integer list when provided."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (2,)
    mock_cur.fetchall.return_value = [
        (101, "Set 1", "Desc 1", "json", None, None, 5),
        (102, "Set 2", "Desc 2", "json", None, None, 10),
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.list_question_sets(allowed_ids=[101, 102])

    assert res["total"] == 2
    assert len(res["items"]) == 2
    assert res["items"][0]["id"] == 101

    executed_sqls = [call[0][0] for call in mock_cur.execute.call_args_list]
    executed_params = [call[0][1] for call in mock_cur.execute.call_args_list]

    assert any("qs.id = ANY(%s)" in sql for sql in executed_sqls)
    assert any([101, 102] in params for params in executed_params)


def test_list_question_sets_empty_allowed_ids_returns_empty_items():
    """Verify list_question_sets short-circuits to empty result when allowed_ids is empty list."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    manager = QuestionDBManager(mock_base_db)

    res = manager.list_question_sets(allowed_ids=[])
    assert res["total"] == 0
    assert res["items"] == []
    mock_base_db.get_connection.assert_not_called()


def test_list_question_sets_none_allowed_ids_omits_any_clause():
    """Verify list_question_sets does not add ANY clause when allowed_ids is None."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (0,)
    mock_cur.fetchall.return_value = []
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.list_question_sets(allowed_ids=None)
    assert res["total"] == 0

    executed_sqls = [call[0][0] for call in mock_cur.execute.call_args_list]
    assert not any("qs.id = ANY(%s)" in sql for sql in executed_sqls)


def test_list_question_sets_string_numeric_ids_converts_to_integers():
    """Verify list_question_sets converts string numeric IDs ('101', '102') to integers."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (2,)
    mock_cur.fetchall.return_value = [
        (101, "Set 1", "Desc 1", "json", None, None, 5),
        (102, "Set 2", "Desc 2", "json", None, None, 10),
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.list_question_sets(allowed_ids=["101", "102"])

    assert res["total"] == 2
    executed_params = [call[0][1] for call in mock_cur.execute.call_args_list]
    assert any([101, 102] in params for params in executed_params)


def test_list_question_sets_non_numeric_ids_returns_empty_items():
    """Verify list_question_sets handles non-numeric string IDs gracefully."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    manager = QuestionDBManager(mock_base_db)

    # All non-numeric IDs filter out to [] -> should short-circuit returning 0
    res = manager.list_question_sets(allowed_ids=["set-abc", "invalid_id", None])  # type: ignore[list-item]
    assert res["total"] == 0
    assert res["items"] == []
    mock_base_db.get_connection.assert_not_called()


# ---------------------------------------------------------------------------
# Unit Tests for EvaluationDBManager
# ---------------------------------------------------------------------------


def test_evaluation_db_manager_init_tables_non_postgres_returns_early():
    """Verify EvaluationDBManager.init_tables returns early when non-PostgreSQL."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = False

    eval_manager = EvaluationDBManager(mock_base_db)
    eval_manager.init_tables()

    mock_base_db.get_connection.assert_not_called()


def test_evaluation_db_manager_init_tables_postgres_creates_tables():
    """Verify EvaluationDBManager.init_tables creates evaluation schema tables."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = True

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    eval_manager = EvaluationDBManager(mock_base_db)
    eval_manager.init_tables()

    assert mock_cur.execute.called
    mock_conn.commit.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_add_questions_valid_data_inserts_and_returns_rows():
    """Verify add_questions inserts question data and updates question_count."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    # 1st fetchone: set check -> (1,)
    # 2nd fetchone: single SQL RETURNING clause -> 12 columns
    mock_cur.fetchone.side_effect = [
        (1,),
        (
            10,
            1,
            "q1",
            "Input Q1",
            "Expected Ans",
            "rag",
            "easy",
            ["doc1"],
            '["ctx1"]',
            '{"tag":"test"}',
            None,
            None,
        ),
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    questions = [
        {
            "question_id": "q1",
            "input": "Input Q1",
            "expected_output": "Expected Ans",
            "category": "rag",
            "level": "easy",
            "expected_doc_ids": ["doc1"],
            "context": ["ctx1"],
            "tag": "test",
        }
    ]
    inserted = manager.add_questions(set_id=1, questions_data=questions)

    assert len(inserted) == 1
    assert inserted[0]["id"] == 10
    assert inserted[0]["question_id"] == "q1"
    assert inserted[0]["input"] == "Input Q1"
    mock_conn.commit.assert_called_once()


def test_question_db_manager_add_questions_with_additional_metadata_unpacks_fields():
    """Verify add_questions unpacks category, level, and expected_doc_ids from additional_metadata."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.side_effect = [
        (1,),
        (
            10,
            1,
            "q1",
            "What is CAIPE?",
            "Expected Ans",
            "rag_category",
            "hard",
            ["doc_123", "doc_456"],
            '["ctx1"]',
            '{"supporting_facts": ["fact 1"]}',
            None,
            None,
        ),
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    questions = [
        {
            "question_id": "q1",
            "input": "What is CAIPE?",
            "expected_output": "Expected Ans",
            "additional_metadata": {
                "category": "rag_category",
                "level": "hard",
                "expected_doc_ids": ["doc_123", "doc_456"],
                "supporting_facts": ["fact 1"],
            },
        }
    ]
    inserted = manager.add_questions(set_id=1, questions_data=questions)

    assert len(inserted) == 1
    assert inserted[0]["category"] == "rag_category"
    assert inserted[0]["level"] == "hard"
    assert inserted[0]["expected_doc_ids"] == ["doc_123", "doc_456"]

    # Verify executed SQL parameters received the unpacked columns
    call_args = mock_cur.execute.call_args_list[
        -2
    ]  # single_sql execution or execute_values
    params = call_args[0][1]
    # (set_id, qid, inp, exp_out, category, level, doc_ids, ctx_json, extra_json)
    assert params[4] == "rag_category"
    assert params[5] == "hard"
    assert params[6] == ["doc_123", "doc_456"]
    assert "supporting_facts" in params[8]
    assert "category" not in params[8]  # category was unpacked, not left in extra


def test_question_db_manager_list_questions_filters_and_paginates():
    """Verify list_questions correctly builds SQL filters, total count, and paginated items."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (1,)  # total count
    mock_cur.fetchall.return_value = [
        (
            10,
            1,
            "q1",
            "What is CAIPE?",
            "Answer",
            "cat1",
            "hard",
            ["d1"],
            '["c1"]',
            '{"k":"v"}',
            None,
            None,
            1,
        )
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.list_questions(
        set_id=1,
        page=1,
        limit=10,
        category="cat1",
        query="CAIPE",
    )

    assert res["total"] == 1
    assert len(res["items"]) == 1
    assert res["items"][0]["question_id"] == "q1"
    assert res["items"][0]["category"] == "cat1"


def test_question_db_manager_stream_questions_yields_items():
    """Verify stream_questions generator streams individual question item dicts."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchall.side_effect = [
        [
            (
                1,
                1,
                "q1",
                "Input 1",
                "Out 1",
                "c1",
                "l1",
                ["d1"],
                '["ctx1"]',
                None,
                None,
                None,
            ),
            (
                2,
                1,
                "q2",
                "Input 2",
                "Out 2",
                "c1",
                "l1",
                ["d2"],
                '["ctx2"]',
                None,
                None,
                None,
            ),
        ],
        [],
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    items = list(manager.stream_questions(set_id=1, batch_size=2))

    assert len(items) == 2
    assert items[0]["question_id"] == "q1"
    assert items[1]["question_id"] == "q2"


def test_question_db_manager_update_question_by_id_success_modifies_record():
    """Verify update_question_by_id updates existing question fields."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (
        10,
        1,
        "q1",
        "New Input",
        "New Output",
        "cat2",
        "hard",
        ["d2"],
        '["ctx2"]',
        None,
        None,
        None,
    )
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    updated = manager.update_question_by_id(
        set_id=1,
        id=10,
        data={
            "input": "New Input",
            "expected_output": "New Output",
            "category": "cat2",
        },
    )

    assert updated is not None
    assert updated["input"] == "New Input"
    assert updated["category"] == "cat2"
    mock_conn.commit.assert_called_once()


def test_question_db_manager_delete_question_by_id_success_removes_question():
    """Verify delete_question_by_id deletes question and updates set count."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (10,)
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    success = manager.delete_question_by_id(set_id=1, id=10)

    assert success is True
    mock_conn.commit.assert_called_once()


def test_question_db_manager_get_question_by_id_found_returns_dict():
    """Verify get_question_by_id returns formatted dictionary when question exists."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (
        10,
        1,
        "q1",
        "In Q1",
        "Out Q1",
        "cat1",
        "easy",
        ["d1"],
        '["c1"]',
        '{"meta":"val"}',
        None,
        None,
    )
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    q = manager.get_question_by_id(set_id=1, id=10)

    assert q is not None
    assert q["id"] == 10
    assert q["extra"] == '{"meta":"val"}' or q["extra"] == {"meta": "val"}


def test_evaluation_db_manager_init_tables_exception_triggers_rollback():
    """Verify EvaluationDBManager.init_tables rolls back connection on execute exception."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = True

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("DB error")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    eval_manager = EvaluationDBManager(mock_base_db)
    with pytest.raises(RuntimeError, match="DB error"):
        eval_manager.init_tables()

    mock_conn.rollback.assert_called_once()


def test_question_db_manager_update_question_by_id_all_branches():
    """Verify update_question_by_id handles aliases user_input, reference, level, doc_ids scalar, context, and extra."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (
        10,
        1,
        "q_new",
        "In User",
        "Ref Out",
        "cat_x",
        "medium",
        ["doc_scalar"],
        '["ctx"]',
        '{"tag":"ext"}',
        None,
        None,
    )
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    updated = manager.update_question_by_id(
        set_id=1,
        id=10,
        data={
            "question_id": "q_new",
            "user_input": "In User",
            "reference": "Ref Out",
            "category": "cat_x",
            "level": "medium",
            "expected_doc_ids": "doc_scalar",
            "context": ["ctx"],
            "extra": {"tag": "ext"},
        },
    )

    assert updated is not None
    assert updated["question_id"] == "q_new"
    assert updated["level"] == "medium"


def test_question_db_manager_update_question_by_id_empty_data_returns_existing():
    """Verify update_question_by_id returns existing question when update dict is empty."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (
        10,
        1,
        "q1",
        "In Q1",
        "Out Q1",
        "cat1",
        "easy",
        ["d1"],
        '["c1"]',
        '{"meta":"val"}',
        None,
        None,
    )
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.update_question_by_id(set_id=1, id=10, data={})
    assert res is not None
    assert res["id"] == 10


def test_question_db_manager_list_questions_all_filters():
    """Verify list_questions builds SQL queries covering level, question_id, question_input, and expected_output filters."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchall.return_value = [
        (
            10,
            1,
            "q1",
            "Input Text",
            "Output Text",
            "cat1",
            "hard",
            ["d1"],
            '["c1"]',
            None,
            None,
            None,
            1,
        )
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.list_questions(
        set_id=1,
        page=1,
        limit=10,
        level="hard",
        question_id="q1",
        question_input="Input",
        expected_output="Output",
    )

    assert res["total"] == 1
    executed_sql = mock_cur.execute.call_args[0][0]
    assert "level = %s" in executed_sql
    assert "question_id = %s" in executed_sql
    assert "input ILIKE" in executed_sql
    assert "expected_output ILIKE" in executed_sql


def test_question_db_manager_init_tables_exception_rollback():
    """Verify init_tables rolls back and re-raises on exception."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = True
    mock_conn = MagicMock()
    mock_conn.cursor.return_value.__enter__.side_effect = RuntimeError("Init SQL error")
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with pytest.raises(RuntimeError, match="Init SQL error"):
        manager.init_tables()
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_create_question_set_exception_rollback():
    """Verify create_question_set rolls back and re-raises on query failure."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Insert failure")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with pytest.raises(RuntimeError, match="Insert failure"):
        manager.create_question_set("Test Set")
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_get_question_set_with_category_distribution():
    """Verify get_question_set includes category distribution summary."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.side_effect = [
        (
            1,
            "QSet 1",
            "Desc",
            "jsonl",
            MagicMock(isoformat=lambda: "2026-08-01T00:00:00Z"),
            MagicMock(isoformat=lambda: "2026-08-01T00:00:00Z"),
            "hashval",
        ),
        (5,),
    ]
    mock_cur.fetchall.return_value = [("finance", 3), (None, 2)]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.get_question_set(1)
    assert res is not None
    assert res["categories"] == {"finance": 3, "uncategorized": 2}
    assert res["question_count"] == 5


def test_question_db_manager_update_question_set_no_updates_returns_existing():
    """Verify update_question_set returns existing question set when no update fields are passed."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    manager = QuestionDBManager(mock_base_db)
    with patch.object(
        manager, "get_question_set", return_value={"id": 1, "name": "Same"}
    ) as mock_get:
        res = manager.update_question_set(1)
        assert res == {"id": 1, "name": "Same"}
        mock_get.assert_called_once_with(1)


def test_question_db_manager_update_question_set_not_found_rolls_back():
    """Verify update_question_set rolls back and returns None when record is not found."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.update_question_set(999, name="New Name")
    assert res is None
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_update_question_set_exception_rollback():
    """Verify update_question_set rolls back and re-raises on database error."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Update error")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with pytest.raises(RuntimeError, match="Update error"):
        manager.update_question_set(1, description="New Desc")
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_delete_question_set_exception_rollback():
    """Verify delete_question_set rolls back and re-raises on database error."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Delete error")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with pytest.raises(RuntimeError, match="Delete error"):
        manager.delete_question_set(1)
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_add_questions_empty_list_returns_empty():
    """Verify add_questions returns empty list immediately when empty list is passed."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    manager = QuestionDBManager(mock_base_db)
    res = manager.add_questions(1, [])
    assert res == []
    mock_base_db.get_connection.assert_not_called()


def test_question_db_manager_update_question_by_id_exception_rollback():
    """Verify update_question_by_id rolls back and re-raises on database error."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Question update error")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with pytest.raises(RuntimeError, match="Question update error"):
        manager.update_question_by_id(1, 10, {"input": "New input"})
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_stream_questions_generator_exit_and_exception():
    """Verify stream_questions closes connection on GeneratorExit and rolls back on exception."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Stream error")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    gen = manager.stream_questions(1)
    with pytest.raises(RuntimeError, match="Stream error"):
        next(gen)
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_delete_question_by_id_exception_rollback():
    """Verify delete_question_by_id rolls back and re-raises on delete failure."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Delete question failure")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with pytest.raises(RuntimeError, match="Delete question failure"):
        manager.delete_question_by_id(1, 10)
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_question_db_manager_batch_delete_questions_empty_and_exception():
    """Verify batch_delete_questions returns 0 for empty list and rolls back on error."""
    mock_base_db = MagicMock(spec=DatabaseManager)
    manager = QuestionDBManager(mock_base_db)

    # Empty list
    assert manager.batch_delete_questions(1, []) == 0
    # List with non-integer items resulting in empty clean list
    assert manager.batch_delete_questions(1, ["invalid"]) == 0

    # Exception path
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Batch delete failed")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    with pytest.raises(RuntimeError, match="Batch delete failed"):
        manager.batch_delete_questions(1, [1, 2, 3])
    mock_conn.rollback.assert_called_once()
    mock_conn.close.assert_called_once()


def test_evaluation_db_manager_init_tables_when_rollback_raises_handles_gracefully() -> (
    None
):
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = True

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Execute failed")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.rollback.side_effect = RuntimeError("Rollback failed")
    mock_base_db.get_connection.return_value = mock_conn

    eval_manager = EvaluationDBManager(mock_base_db)
    with pytest.raises(RuntimeError, match="Execute failed"):
        eval_manager.init_tables()


def test_evaluation_db_manager_get_cached_job_by_hash_when_metrics_missing_and_corrupt_config() -> (
    None
):
    import time

    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = True

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    # Row format:
    # 0: job_id, 1: eval_hash, 2: status, 3: config_json, 4: created_at, 5: completed_at, 6: error,
    # 7: metrics, 8: failure_causes, 9: evaluator_usage, 10: p50, 11: p95, 12: total_dur, 13: total_q, 14: comp_q
    mock_cur.fetchone.return_value = (
        "job-corrupt-1",
        "hash-123",
        "completed",
        "invalid-json{",
        time.time(),
        time.time() + 1.0,
        None,
        None,  # metrics is None
        None,
        None,
        0.5,
        0.9,
        2.0,
        10,
        10,
    )
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    eval_manager = EvaluationDBManager(mock_base_db)
    with patch.object(eval_manager, "get_job_results_payload", return_value=[]):
        res = eval_manager.get_cached_job_by_hash("hash-123")
        assert res is not None
        assert res["job_id"] == "job-corrupt-1"
        assert res["config_args"] == {}
        assert res["summary"] == {}


def test_evaluation_db_manager_get_job_results_payload_when_metrics_and_pipeline_usage_as_string_json() -> (
    None
):
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = True

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    # r format:
    # 0: q_id, 1: u_in, 2: ref, 3: act_out, 4: ctx_gt, 5: ret_ctx, 6: exp_docs, 7: ret_docs, 8: metrics_val, 9: lat, 10: pipe_usage
    mock_cur.fetchall.return_value = [
        (
            "q1",
            "User in",
            "Ref text",
            "Act text",
            '["ctx_gold"]',
            '["ctx_ret"]',
            '["doc_exp"]',
            '["doc_ret"]',
            '{"Faithfulness": 0.9}',
            0.45,
            '{"total_tokens": 120}',
        )
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    eval_manager = EvaluationDBManager(mock_base_db)
    payloads = eval_manager.get_job_results_payload("job-1")
    assert len(payloads) == 1
    assert payloads[0]["Faithfulness"] == 0.9
    assert payloads[0]["pipeline_usage"] == {"total_tokens": 120}


def test_question_db_manager_find_by_content_hash_when_not_postgres_returns_none() -> (
    None
):
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_base_db.is_postgres.return_value = False
    manager = QuestionDBManager(mock_base_db)
    assert manager.find_by_content_hash("hash123") is None
    assert manager.find_by_content_hash("") is None


def test_question_db_manager_update_question_set_with_source_format() -> None:
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (1,)
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    with patch.object(
        manager, "get_question_set", return_value={"id": 1, "source_format": "csv"}
    ):
        res = manager.update_question_set(1, source_format="csv")
        assert res is not None
        assert res["source_format"] == "csv"


def test_question_db_manager_list_questions_when_offset_greater_than_zero_and_no_rows() -> (
    None
):
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchall.return_value = []
    mock_cur.fetchone.return_value = (5,)  # total count = 5
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    res = manager.list_questions(set_id=1, page=2, limit=10)
    assert res["items"] == []
    assert res["total"] == 5


def test_question_db_manager_delete_question_by_id_when_not_found_returns_false() -> (
    None
):
    mock_base_db = MagicMock(spec=DatabaseManager)
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_base_db.get_connection.return_value = mock_conn

    manager = QuestionDBManager(mock_base_db)
    assert manager.delete_question_by_id(1, 999) is False
