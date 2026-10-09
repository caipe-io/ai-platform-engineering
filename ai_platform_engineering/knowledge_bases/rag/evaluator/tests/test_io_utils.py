import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from deepeval_eval.core.io_utils import (
    download_bytes,
    download_text,
    load_eval_questions,
    parse_indices,
    sanitize_path,
)


def test_sanitize_path() -> None:
    """Verify sanitize_path strips parent directories, relative paths, and trailing slashes."""
    assert sanitize_path(None) is None
    assert sanitize_path(123) == 123  # Non-string passes through
    assert sanitize_path("") == ""
    assert sanitize_path("/etc/passwd") == "passwd"
    assert sanitize_path("/var/log/results/") == "results"
    assert sanitize_path("data/subfolder/questions.jsonl") == "questions.jsonl"
    assert sanitize_path("simple_filename.csv") == "simple_filename.csv"


def test_download_text_positive(tmp_path: Path) -> None:
    cache_path = tmp_path / "cache.txt"
    mock_resp = MagicMock()
    mock_resp.text = "downloaded content"

    with patch("requests.get", return_value=mock_resp):
        res = download_text("http://example.com/test.txt", cache_path)
        assert res == "downloaded content"
        assert cache_path.read_text() == "downloaded content"

    # Cached hit
    res_cached = download_text("http://example.com/test.txt", cache_path)
    assert res_cached == "downloaded content"


def test_download_bytes_positive(tmp_path: Path) -> None:
    cache_path = tmp_path / "cache.bin"
    mock_resp = MagicMock()
    mock_resp.content = b"downloaded bytes"

    with patch("requests.get", return_value=mock_resp):
        res = download_bytes("http://example.com/test.bin", cache_path)
        assert res == b"downloaded bytes"
        assert cache_path.read_bytes() == b"downloaded bytes"

    # Cached hit
    res_cached = download_bytes("http://example.com/test.bin", cache_path)
    assert res_cached == b"downloaded bytes"


def test_load_eval_questions_category_limit(tmp_path: Path) -> None:
    jsonl_path = tmp_path / "questions.jsonl"
    jsonl_path.write_text(
        '{"category": "cat1", "level": "easy"}\n'
        '{"category": "cat1", "level": "easy"}\n'
        '{"category": "cat1", "level": "hard"}\n'
    )

    rows = load_eval_questions(
        jsonl_path, max_items=None, limit_per_category=1, combine_with_level=True
    )
    assert len(rows) == 2  # 1 for cat1-easy, 1 for cat1-hard


def test_load_eval_questions_basic(tmp_path: Path):
    # Prepare a mock jsonl file
    questions_file = tmp_path / "questions.jsonl"
    data = [
        {"user_input": "q1", "reference": "r1", "category": "cat1"},
        {"user_input": "q2", "reference": "r2", "category": "cat2"},
        {"user_input": "q3", "reference": "r3", "category": "cat1"},
        {"user_input": "q4", "reference": "r4", "category": "cat2"},
        {"user_input": "q5", "reference": "r5", "category": "cat3"},
    ]
    with open(questions_file, "w", encoding="utf-8") as f:
        for item in data:
            f.write(json.dumps(item) + "\n")

    # 1. Test basic loading without limits
    rows = load_eval_questions(questions_file, max_items=None, limit_per_category=None)
    assert len(rows) == 5
    assert [r["user_input"] for r in rows] == ["q1", "q2", "q3", "q4", "q5"]

    # 2. Test max_items limit
    rows = load_eval_questions(questions_file, max_items=3, limit_per_category=None)
    assert len(rows) == 3
    assert [r["user_input"] for r in rows] == ["q1", "q2", "q3"]

    # 3. Test limit_per_category limit
    # Expected: "cat1" has q1 (kept), q3 (kept if limit >= 2). With limit 1, we keep q1, q2, q4 (since cat2 limit is 1, keep q2 and drop q4), q5.
    # Let's check with limit_per_category = 1
    rows = load_eval_questions(questions_file, max_items=None, limit_per_category=1)
    assert len(rows) == 3
    assert [r["user_input"] for r in rows] == ["q1", "q2", "q5"]

    # 4. Test combination of both max_items and limit_per_category
    rows = load_eval_questions(questions_file, max_items=2, limit_per_category=1)
    assert len(rows) == 2
    assert [r["user_input"] for r in rows] == ["q1", "q2"]


def test_load_eval_questions_missing_category(tmp_path: Path):
    questions_file = tmp_path / "questions.jsonl"
    data = [
        {"user_input": "q1", "reference": "r1"},
        {"user_input": "q2", "reference": "r2"},
    ]
    with open(questions_file, "w", encoding="utf-8") as f:
        for item in data:
            f.write(json.dumps(item) + "\n")

    # With missing category, it defaults to 'basic'
    rows = load_eval_questions(questions_file, max_items=None, limit_per_category=1)
    assert len(rows) == 1
    assert rows[0]["user_input"] == "q1"


def test_load_eval_questions_combine_with_level(tmp_path: Path):
    questions_file = tmp_path / "questions_level.jsonl"
    data = [
        {"user_input": "q1", "category": "cat1", "level": "easy"},
        {"user_input": "q2", "category": "cat1", "level": "easy"},
        {"user_input": "q3", "category": "cat1", "level": "hard"},
        {"user_input": "q4", "category": "cat1", "level": "hard"},
    ]
    with open(questions_file, "w", encoding="utf-8") as f:
        for item in data:
            f.write(json.dumps(item) + "\n")

    # With combine_with_level=False, we only get q1 (limit_per_category=1)
    rows_default = load_eval_questions(
        questions_file, max_items=None, limit_per_category=1, combine_with_level=False
    )
    assert len(rows_default) == 1
    assert rows_default[0]["user_input"] == "q1"

    # With combine_with_level=True, we get q1 (easy) and q3 (hard)
    rows_combined = load_eval_questions(
        questions_file, max_items=None, limit_per_category=1, combine_with_level=True
    )
    assert len(rows_combined) == 2
    assert [r["user_input"] for r in rows_combined] == ["q1", "q3"]


def test_parse_indices():
    # Basic list
    assert parse_indices("1,2,5", 10) == {1, 2, 5}
    # Ranges
    assert parse_indices("1-3,5-7", 10) == {1, 2, 3, 5, 6, 7}
    # Out of range values ignored
    assert parse_indices("1,12", 10) == {1}
    # Handles invalid formatting gracefully
    assert parse_indices("abc,2-xyz,5", 10) == {5}


def test_question_filtering_logic(tmp_path: Path):
    questions_file = tmp_path / "filter_questions.jsonl"
    data = [
        {"question_id": "q_1", "user_input": "query 1", "category": "cat1"},
        {"question_id": "q_2", "user_input": "query 2", "category": "cat1"},
        {"question_id": "q_3", "user_input": "query 3", "category": "cat2"},
        {"question_id": "q_4", "user_input": "query 4", "category": "cat2"},
    ]
    with open(questions_file, "w", encoding="utf-8") as f:
        for item in data:
            f.write(json.dumps(item) + "\n")

    # Mock arguments
    class MockArgs:
        def __init__(self, q_ids=None, q_indices=None, limit_cat=None, max_it=None):
            self.questions_file = questions_file
            self.question_ids = q_ids
            self.question_indices = q_indices
            self.limit_per_category = limit_cat
            self.max_items = max_it

    # Case A: Filter by question_ids -> should bypass limit_per_category
    args_a = MockArgs(q_ids="q_2,q_4", limit_cat=1)
    if args_a.question_ids:
        rows = load_eval_questions(args_a.questions_file, None, None)
        target_ids = {qid.strip() for qid in args_a.question_ids.split(",")}
        rows = [row for row in rows if str(row.get("question_id")) in target_ids]
    assert len(rows) == 2
    assert {r["question_id"] for r in rows} == {"q_2", "q_4"}

    # Case B: Filter by question_indices -> should respect limit_per_category
    args_b = MockArgs(q_indices="2", limit_cat=1)
    rows = load_eval_questions(
        args_b.questions_file, args_b.max_items, args_b.limit_per_category
    )
    # limit_per_category=1 means we load:
    # - q_1 (from cat1)
    # - q_3 (from cat2)
    # So rows contains [q_1, q_3]. Index 2 should map to q_3.
    assert len(rows) == 2
    assert rows[0]["question_id"] == "q_1"
    assert rows[1]["question_id"] == "q_3"
    target_indices = parse_indices(args_b.question_indices, len(rows))
    filtered_rows = [rows[i - 1] for i in sorted(target_indices) if 1 <= i <= len(rows)]
    assert len(filtered_rows) == 1
    assert filtered_rows[0]["question_id"] == "q_3"


def test_load_eval_questions_blank_lines_handling(tmp_path: Path) -> None:
    questions_file = tmp_path / "questions_with_blanks.jsonl"
    questions_file.write_text(
        "\n\n"
        '{"user_input": "q1", "category": "cat1"}\n'
        "   \n"
        '{"user_input": "q2", "category": "cat1"}\n'
        "\n",
        encoding="utf-8",
    )
    rows = load_eval_questions(questions_file, max_items=None)
    assert len(rows) == 2
    assert [r["user_input"] for r in rows] == ["q1", "q2"]


def test_parse_indices_inverted_and_boundary_ranges() -> None:
    # Inverted range start > end
    assert parse_indices("5-2", 10) == set()
    # Mixed with valid indices
    assert parse_indices("1, 8-3, 4", 10) == {1, 4}
