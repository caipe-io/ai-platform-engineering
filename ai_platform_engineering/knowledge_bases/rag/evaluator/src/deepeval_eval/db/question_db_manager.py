from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

try:
    from psycopg2.extras import execute_values
except ImportError:
    execute_values = None

if TYPE_CHECKING:
    from deepeval_eval.db.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

MAX_BATCH_DELETE_ITEMS = 1000
TOUCH_QUESTION_SET_UPDATED_AT_SQL = (
    "UPDATE question_sets SET updated_at = now() WHERE id = %s;"
)


def _escape_like_wildcards(text: str) -> str:
    """Escape SQL LIKE wildcard characters in user search terms."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class QuestionDBManager:
    """PostgreSQL database manager for Question Sets and Questions."""

    def __init__(self, db_manager: DatabaseManager) -> None:
        self.db_manager = db_manager

    def init_tables(self) -> None:
        """Initialize PostgreSQL schema for question_sets and questions."""
        if not self.db_manager.is_postgres():
            return

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS question_sets (
                        id            BIGSERIAL PRIMARY KEY,
                        name          TEXT NOT NULL,
                        description   TEXT,
                        source_format TEXT,
                        content_hash  TEXT,
                        created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                        updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                    );

                    CREATE TABLE IF NOT EXISTS questions (
                        id               BIGSERIAL PRIMARY KEY,
                        question_set_id  BIGINT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
                        question_id      TEXT,
                        input            TEXT NOT NULL,
                        expected_output  TEXT,
                        category         TEXT,
                        level            TEXT,
                        expected_doc_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
                        context          JSONB,
                        extra            JSONB,
                        created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                        updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                        CONSTRAINT questions_question_set_id_question_id_key UNIQUE (question_set_id, question_id)
                    );

                    ALTER TABLE question_sets ADD COLUMN IF NOT EXISTS content_hash TEXT;
                    CREATE INDEX IF NOT EXISTS idx_question_sets_content_hash ON question_sets (content_hash);
                    CREATE INDEX IF NOT EXISTS idx_question_sets_name ON question_sets (name);
                    CREATE INDEX IF NOT EXISTS idx_questions_set_category ON questions (question_set_id, category);
                    CREATE INDEX IF NOT EXISTS idx_questions_set_id ON questions (question_set_id, id);

                    CREATE OR REPLACE FUNCTION set_default_question_id()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        IF NEW.question_id IS NULL OR TRIM(NEW.question_id) = '' THEN
                            NEW.question_id := NEW.id::text;
                        END IF;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;

                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_trigger
                            WHERE tgname = 'trg_set_default_question_id'
                              AND tgrelid = 'questions'::regclass
                        ) THEN
                            CREATE TRIGGER trg_set_default_question_id
                            BEFORE INSERT ON questions
                            FOR EACH ROW EXECUTE FUNCTION set_default_question_id();
                        END IF;
                    END $$;
                    """
                )
            conn.commit()
        except Exception as exc:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            logger.warning(f"QuestionDBManager table initialization failed: {exc}")
            raise
        finally:
            conn.close()

    def find_by_content_hash(self, content_hash: str) -> dict[str, Any] | None:
        """Find an existing question set by its SHA-256 content hash."""
        if not content_hash or not self.db_manager.is_postgres():
            return None
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, name, description, source_format, created_at, updated_at, content_hash
                    FROM question_sets
                    WHERE content_hash = %s
                    ORDER BY id ASC
                    LIMIT 1;
                    """,
                    (content_hash,),
                )
                row = cur.fetchone()
                if not row:
                    return None

                cur.execute(
                    "SELECT COUNT(*) FROM questions WHERE question_set_id = %s;",
                    (row[0],),
                )
                count_row = cur.fetchone()
                question_count = count_row[0] if count_row else 0

                return {
                    "id": row[0],
                    "name": row[1],
                    "description": row[2],
                    "source_format": row[3],
                    "created_at": (
                        row[4].isoformat() if hasattr(row[4], "isoformat") else row[4]
                    ),
                    "updated_at": (
                        row[5].isoformat() if hasattr(row[5], "isoformat") else row[5]
                    ),
                    "content_hash": row[6],
                    "question_count": question_count,
                }
        finally:
            conn.close()

    def create_question_set(
        self,
        name: str,
        description: str | None = None,
        source_format: str | None = None,
        content_hash: str | None = None,
    ) -> dict[str, Any]:
        """Create a new question set."""
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO question_sets (name, description, source_format, content_hash)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id, name, description, source_format, created_at, updated_at, content_hash;
                    """,
                    (name, description, source_format, content_hash),
                )
                row = cur.fetchone()
                conn.commit()
                return {
                    "id": row[0],
                    "name": row[1],
                    "description": row[2],
                    "source_format": row[3],
                    "created_at": (
                        row[4].isoformat() if hasattr(row[4], "isoformat") else row[4]
                    ),
                    "updated_at": (
                        row[5].isoformat() if hasattr(row[5], "isoformat") else row[5]
                    ),
                    "content_hash": row[6],
                    "question_count": 0,
                }
        except Exception:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            conn.close()

    def list_question_sets(
        self,
        page: int = 1,
        limit: int = 50,
        query: str | None = None,
        allowed_ids: list[int] | None = None,
    ) -> dict[str, Any]:
        """List question sets with pagination, search, and ReBAC allowed_ids filter."""
        if allowed_ids is not None:
            int_allowed_ids = [
                int(x)
                for x in allowed_ids
                if isinstance(x, (int, str)) and str(x).isdigit()
            ]
            if len(int_allowed_ids) == 0:
                return {
                    "items": [],
                    "total": 0,
                    "page": page,
                    "limit": limit,
                    "total_pages": 0,
                }
        else:
            int_allowed_ids = None

        offset = (max(1, page) - 1) * limit
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                where_clauses: list[str] = []
                params: list[Any] = []
                if query and query.strip():
                    where_clauses.append(
                        "(qs.name ILIKE %s ESCAPE '\\' OR qs.description ILIKE %s ESCAPE '\\')"
                    )
                    search_pat = f"%{_escape_like_wildcards(query.strip())}%"
                    params.extend([search_pat, search_pat])

                if int_allowed_ids is not None:
                    where_clauses.append("qs.id = ANY(%s)")
                    params.append(int_allowed_ids)

                where_clause = (
                    f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""
                )

                # Count total matching rows
                count_sql = f"SELECT COUNT(*) FROM question_sets qs {where_clause};"
                cur.execute(count_sql, tuple(params))
                total = cur.fetchone()[0]

                # Fetch paginated question sets using correlated subquery for count aggregation
                fetch_sql = f"""
                    SELECT 
                        qs.id, 
                        qs.name, 
                        qs.description, 
                        qs.source_format, 
                        qs.created_at, 
                        qs.updated_at,
                        (SELECT COUNT(*) FROM questions q WHERE q.question_set_id = qs.id) AS question_count
                    FROM question_sets qs
                    {where_clause}
                    ORDER BY qs.id DESC
                    LIMIT %s OFFSET %s;
                """
                fetch_params = params + [limit, offset]
                cur.execute(fetch_sql, tuple(fetch_params))
                rows = cur.fetchall()

                items = [
                    {
                        "id": r[0],
                        "name": r[1],
                        "description": r[2],
                        "source_format": r[3],
                        "created_at": r[4].isoformat() if r[4] else None,
                        "updated_at": r[5].isoformat() if r[5] else None,
                        "question_count": r[6],
                    }
                    for r in rows
                ]

                return {
                    "items": items,
                    "total": total,
                    "page": page,
                    "limit": limit,
                    "total_pages": (total + limit - 1) // limit if limit > 0 else 0,
                }
        finally:
            conn.close()

    def get_question_set(self, set_id: int) -> dict[str, Any] | None:
        """Get details and summary stats of a question set by ID."""
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, name, description, source_format, created_at, updated_at, content_hash
                    FROM question_sets
                    WHERE id = %s;
                    """,
                    (set_id,),
                )
                row = cur.fetchone()
                if not row:
                    return None

                # Fetch question count
                cur.execute(
                    "SELECT COUNT(*) FROM questions WHERE question_set_id = %s;",
                    (set_id,),
                )
                count_row = cur.fetchone()
                question_count = count_row[0] if count_row else 0

                # Fetch category distribution stats
                cur.execute(
                    """
                    SELECT category, COUNT(*) 
                    FROM questions 
                    WHERE question_set_id = %s 
                    GROUP BY category;
                    """,
                    (set_id,),
                )
                cat_rows = cur.fetchall()
                categories = {
                    (cat if cat is not None else "uncategorized"): cnt
                    for cat, cnt in cat_rows
                }

                return {
                    "id": row[0],
                    "name": row[1],
                    "description": row[2],
                    "source_format": row[3],
                    "created_at": (
                        row[4].isoformat() if hasattr(row[4], "isoformat") else row[4]
                    ),
                    "updated_at": (
                        row[5].isoformat() if hasattr(row[5], "isoformat") else row[5]
                    ),
                    "content_hash": row[6],
                    "question_count": question_count,
                    "categories": categories,
                }
        finally:
            conn.close()

    def update_question_set(
        self,
        set_id: int,
        name: str | None = None,
        description: str | None = None,
        source_format: str | None = None,
    ) -> dict[str, Any] | None:
        """Update metadata of a question set."""
        updates: list[str] = []
        params: list[Any] = []

        if name is not None:
            updates.append("name = %s")
            params.append(name)
        if description is not None:
            updates.append("description = %s")
            params.append(description)
        if source_format is not None:
            updates.append("source_format = %s")
            params.append(source_format)

        if not updates:
            return self.get_question_set(set_id)

        updates.append("updated_at = now()")
        params.append(set_id)

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE question_sets SET {', '.join(updates)} WHERE id = %s RETURNING id;",
                    tuple(params),
                )
                if cur.fetchone() is None:
                    if hasattr(conn, "rollback"):
                        conn.rollback()
                    return None
                conn.commit()
            return self.get_question_set(set_id)
        except Exception:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            conn.close()

    def delete_question_set(self, set_id: int) -> bool:
        """Delete a question set and all associated questions."""
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM question_sets WHERE id = %s RETURNING id;", (set_id,)
                )
                row = cur.fetchone()
                conn.commit()
                return row is not None
        except Exception:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            conn.close()

    def add_questions(
        self, set_id: int, questions_data: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Batch insert questions into a question set."""
        if not questions_data:
            return []

        conn = self.db_manager.get_connection()
        inserted_rows: list[dict[str, Any]] = []
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM question_sets WHERE id = %s;", (set_id,))
                if not cur.fetchone():
                    raise ValueError(f"Question set with id={set_id} does not exist.")

                prepared_params: list[tuple[Any, ...]] = []
                for idx, item in enumerate(questions_data, start=1):
                    # Key mappings for alias compatibility (user_input -> input, reference -> expected_output)
                    inp = item.get("input") or item.get("user_input")
                    if not inp:
                        raise ValueError(
                            f"Question item at index {idx} missing required field 'input' or 'user_input'."
                        )

                    qid = item.get("question_id")
                    if not qid or not str(qid).strip():
                        qid = None
                    else:
                        qid = str(qid).strip()

                    add_meta = item.get("additional_metadata")
                    if not isinstance(add_meta, dict):
                        add_meta = {}

                    exp_out = item.get("expected_output") or item.get("reference")
                    category = item.get("category") or add_meta.get("category")
                    level = item.get("level") or add_meta.get("level")
                    doc_ids = (
                        item.get("expected_doc_ids")
                        or add_meta.get("expected_doc_ids")
                        or []
                    )
                    if not isinstance(doc_ids, list):
                        doc_ids = [str(doc_ids)]
                    else:
                        doc_ids = [str(d) for d in doc_ids]

                    ctx = item.get("context") or add_meta.get("context")
                    extra = item.get("extra")

                    # If extra metadata fields exist in item outside known schema fields, capture in extra dict
                    known_keys = {
                        "question_id",
                        "input",
                        "user_input",
                        "expected_output",
                        "reference",
                        "category",
                        "level",
                        "expected_doc_ids",
                        "context",
                        "extra",
                        "additional_metadata",
                    }
                    leftover_keys = {
                        k: v for k, v in item.items() if k not in known_keys
                    }
                    # Also include any leftover fields from additional_metadata
                    known_add_meta_keys = {
                        "category",
                        "level",
                        "expected_doc_ids",
                        "context",
                    }
                    leftover_add_meta = {
                        k: v
                        for k, v in add_meta.items()
                        if k not in known_add_meta_keys
                    }
                    if leftover_add_meta:
                        leftover_keys.update(leftover_add_meta)

                    if leftover_keys:
                        if extra is None:
                            extra = leftover_keys
                        elif isinstance(extra, dict):
                            extra = {**extra, **leftover_keys}

                    ctx_json = json.dumps(ctx) if ctx is not None else None
                    extra_json = json.dumps(extra) if extra is not None else None

                    prepared_params.append(
                        (
                            set_id,
                            qid,
                            inp,
                            exp_out,
                            category,
                            level,
                            doc_ids,
                            ctx_json,
                            extra_json,
                        )
                    )

                batch_sql = """
                    INSERT INTO questions (
                        question_set_id, question_id, input, expected_output,
                        category, level, expected_doc_ids, context, extra
                    )
                    VALUES %s
                    ON CONFLICT (question_set_id, question_id) 
                    DO UPDATE SET
                        input = EXCLUDED.input,
                        expected_output = EXCLUDED.expected_output,
                        category = EXCLUDED.category,
                        level = EXCLUDED.level,
                        expected_doc_ids = EXCLUDED.expected_doc_ids,
                        context = EXCLUDED.context,
                        extra = EXCLUDED.extra,
                        updated_at = now()
                    RETURNING id, question_set_id, question_id, input, expected_output,
                              category, level, expected_doc_ids, context, extra, created_at, updated_at;
                """

                single_sql = """
                    INSERT INTO questions (
                        question_set_id, question_id, input, expected_output,
                        category, level, expected_doc_ids, context, extra
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (question_set_id, question_id) 
                    DO UPDATE SET
                        input = EXCLUDED.input,
                        expected_output = EXCLUDED.expected_output,
                        category = EXCLUDED.category,
                        level = EXCLUDED.level,
                        expected_doc_ids = EXCLUDED.expected_doc_ids,
                        context = EXCLUDED.context,
                        extra = EXCLUDED.extra,
                        updated_at = now()
                    RETURNING id, question_set_id, question_id, input, expected_output,
                              category, level, expected_doc_ids, context, extra, created_at, updated_at;
                """

                use_batch = execute_values is not None
                if use_batch:
                    try:
                        fetched = execute_values(
                            cur, batch_sql, prepared_params, fetch=True
                        )
                        for r in fetched:
                            inserted_rows.append(
                                {
                                    "id": r[0],
                                    "question_set_id": r[1],
                                    "question_id": r[2],
                                    "input": r[3],
                                    "expected_output": r[4],
                                    "category": r[5],
                                    "level": r[6],
                                    "expected_doc_ids": r[7],
                                    "context": r[8],
                                    "extra": r[9],
                                    "created_at": r[10].isoformat() if r[10] else None,
                                    "updated_at": r[11].isoformat() if r[11] else None,
                                }
                            )
                    except Exception as batch_exc:
                        logger.warning(
                            "execute_values batch insert failed, falling back to row-by-row: %s",
                            batch_exc,
                        )
                        inserted_rows = []
                        use_batch = False

                if not use_batch:
                    for row_params in prepared_params:
                        cur.execute(single_sql, row_params)
                        r = cur.fetchone()
                        if r:
                            inserted_rows.append(
                                {
                                    "id": r[0],
                                    "question_set_id": r[1],
                                    "question_id": r[2],
                                    "input": r[3],
                                    "expected_output": r[4],
                                    "category": r[5],
                                    "level": r[6],
                                    "expected_doc_ids": r[7],
                                    "context": r[8],
                                    "extra": r[9],
                                    "created_at": r[10].isoformat() if r[10] else None,
                                    "updated_at": r[11].isoformat() if r[11] else None,
                                }
                            )

                # Touch updated_at on question set
                cur.execute(
                    TOUCH_QUESTION_SET_UPDATED_AT_SQL,
                    (set_id,),
                )
                conn.commit()
                return inserted_rows
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def list_questions(
        self,
        set_id: int,
        page: int = 1,
        limit: int = 50,
        category: str | None = None,
        level: str | None = None,
        query: str | None = None,
        question_id: str | None = None,
        question_input: str | None = None,
        expected_output: str | None = None,
    ) -> dict[str, Any]:
        """List questions in a question set with pagination and filters."""
        offset = (max(1, page) - 1) * limit
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                where_clauses = ["question_set_id = %s"]
                params: list[Any] = [set_id]

                if category and category.strip():
                    where_clauses.append("category = %s")
                    params.append(category.strip())
                if level and level.strip():
                    where_clauses.append("level = %s")
                    params.append(level.strip())
                if question_id and question_id.strip():
                    where_clauses.append("question_id = %s")
                    params.append(question_id.strip())
                if question_input and question_input.strip():
                    where_clauses.append("input ILIKE %s ESCAPE '\\'")
                    params.append(f"%{_escape_like_wildcards(question_input.strip())}%")
                if expected_output and expected_output.strip():
                    where_clauses.append("expected_output ILIKE %s ESCAPE '\\'")
                    params.append(
                        f"%{_escape_like_wildcards(expected_output.strip())}%"
                    )
                if query and query.strip():
                    where_clauses.append(
                        "(input ILIKE %s ESCAPE '\\' OR expected_output ILIKE %s ESCAPE '\\' OR question_id ILIKE %s ESCAPE '\\')"
                    )
                    pat = f"%{_escape_like_wildcards(query.strip())}%"
                    params.extend([pat, pat, pat])

                where_sql = " WHERE " + " AND ".join(where_clauses)

                # Fetch rows and total count in a single pass using COUNT(*) OVER()
                fetch_sql = f"""
                    SELECT 
                        id, question_set_id, question_id, input, expected_output,
                        category, level, expected_doc_ids, context, extra, created_at, updated_at,
                        COUNT(*) OVER() AS total_count
                    FROM questions
                    {where_sql}
                    ORDER BY id ASC
                    LIMIT %s OFFSET %s;
                """
                fetch_params = params + [limit, offset]
                cur.execute(fetch_sql, tuple(fetch_params))
                rows = cur.fetchall()

                if not rows:
                    total = 0
                    if offset > 0:
                        cur.execute(
                            f"SELECT COUNT(*) FROM questions{where_sql};", tuple(params)
                        )
                        total = cur.fetchone()[0]
                    return {
                        "items": [],
                        "total": total,
                        "page": page,
                        "limit": limit,
                        "total_pages": (total + limit - 1) // limit if limit > 0 else 0,
                    }

                total = rows[0][12]
                items = [
                    {
                        "id": r[0],
                        "question_set_id": r[1],
                        "question_id": r[2],
                        "input": r[3],
                        "expected_output": r[4],
                        "category": r[5],
                        "level": r[6],
                        "expected_doc_ids": r[7] if r[7] is not None else [],
                        "context": r[8],
                        "extra": r[9],
                        "created_at": r[10].isoformat() if r[10] else None,
                        "updated_at": r[11].isoformat() if r[11] else None,
                    }
                    for r in rows
                ]

                return {
                    "items": items,
                    "total": total,
                    "page": page,
                    "limit": limit,
                    "total_pages": (total + limit - 1) // limit if limit > 0 else 0,
                }
        finally:
            conn.close()

    def stream_questions(
        self, set_id: int, batch_size: int = 1000
    ) -> Iterator[dict[str, Any]]:
        """Stream questions in batches using keyset pagination (WHERE id > last_id) for zero offset drift."""
        conn = self.db_manager.get_connection()
        try:
            last_id = 0
            while True:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT id, question_set_id, question_id, input, expected_output,
                               category, level, expected_doc_ids, context, extra, created_at, updated_at
                        FROM questions
                        WHERE question_set_id = %s AND id > %s
                        ORDER BY id ASC
                        LIMIT %s;
                        """,
                        (set_id, last_id, batch_size),
                    )
                    rows = cur.fetchall()
                    if not rows:
                        break
                    for r in rows:
                        yield {
                            "id": r[0],
                            "question_set_id": r[1],
                            "question_id": r[2],
                            "input": r[3],
                            "expected_output": r[4],
                            "category": r[5],
                            "level": r[6],
                            "expected_doc_ids": r[7] if r[7] is not None else [],
                            "context": r[8],
                            "extra": r[9],
                            "created_at": r[10].isoformat() if r[10] else None,
                            "updated_at": r[11].isoformat() if r[11] else None,
                        }
                    last_id = rows[-1][0]
        except GeneratorExit:
            pass
        except Exception:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            if conn is not None and hasattr(conn, "close"):
                conn.close()

    def get_question_by_id(self, set_id: int, id: int) -> dict[str, Any] | None:
        """Get a single question by id."""
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, question_set_id, question_id, input, expected_output,
                           category, level, expected_doc_ids, context, extra, created_at, updated_at
                    FROM questions
                    WHERE question_set_id = %s AND id = %s;
                    """,
                    (set_id, id),
                )
                r = cur.fetchone()
                if not r:
                    return None
                return {
                    "id": r[0],
                    "question_set_id": r[1],
                    "question_id": r[2],
                    "input": r[3],
                    "expected_output": r[4],
                    "category": r[5],
                    "level": r[6],
                    "expected_doc_ids": r[7] if r[7] is not None else [],
                    "context": r[8],
                    "extra": r[9],
                    "created_at": r[10].isoformat() if r[10] else None,
                    "updated_at": r[11].isoformat() if r[11] else None,
                }
        finally:
            conn.close()

    def update_question_by_id(
        self, set_id: int, id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Update a specific question by primary key id."""
        updates: list[str] = []
        params: list[Any] = []

        if "question_id" in data and data["question_id"] is not None:
            updates.append("question_id = %s")
            params.append(data["question_id"])
        if "input" in data and data["input"] is not None:
            updates.append("input = %s")
            params.append(data["input"])
        elif "user_input" in data and data["user_input"] is not None:
            updates.append("input = %s")
            params.append(data["user_input"])
        if "expected_output" in data:
            updates.append("expected_output = %s")
            params.append(data["expected_output"])
        elif "reference" in data:
            updates.append("expected_output = %s")
            params.append(data["reference"])
        if "category" in data:
            updates.append("category = %s")
            params.append(data["category"])
        if "level" in data:
            updates.append("level = %s")
            params.append(data["level"])
        if "expected_doc_ids" in data and data["expected_doc_ids"] is not None:
            doc_ids = data["expected_doc_ids"]
            if not isinstance(doc_ids, list):
                doc_ids = [str(doc_ids)]
            else:
                doc_ids = [str(d) for d in doc_ids]
            updates.append("expected_doc_ids = %s")
            params.append(doc_ids)
        if "context" in data:
            updates.append("context = %s")
            params.append(
                json.dumps(data["context"]) if data["context"] is not None else None
            )
        if "extra" in data:
            updates.append("extra = %s")
            params.append(
                json.dumps(data["extra"]) if data["extra"] is not None else None
            )

        if not updates:
            return self.get_question_by_id(set_id, id)

        updates.append("updated_at = now()")
        params.extend([set_id, id])

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                sql = f"""
                    UPDATE questions
                    SET {", ".join(updates)}
                    WHERE question_set_id = %s AND id = %s
                    RETURNING id, question_set_id, question_id, input, expected_output,
                              category, level, expected_doc_ids, context, extra, created_at, updated_at;
                """
                cur.execute(sql, tuple(params))
                r = cur.fetchone()
                if not r:
                    return None
                cur.execute(
                    TOUCH_QUESTION_SET_UPDATED_AT_SQL,
                    (set_id,),
                )
                conn.commit()
                return {
                    "id": r[0],
                    "question_set_id": r[1],
                    "question_id": r[2],
                    "input": r[3],
                    "expected_output": r[4],
                    "category": r[5],
                    "level": r[6],
                    "expected_doc_ids": r[7] if r[7] is not None else [],
                    "context": r[8],
                    "extra": r[9],
                    "created_at": r[10].isoformat() if r[10] else None,
                    "updated_at": r[11].isoformat() if r[11] else None,
                }
        except Exception:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            conn.close()

    def delete_question_by_id(self, set_id: int, id: int) -> bool:
        """Delete a single question from a set by id."""
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM questions WHERE question_set_id = %s AND id = %s RETURNING id;",
                    (set_id, id),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        TOUCH_QUESTION_SET_UPDATED_AT_SQL,
                        (set_id,),
                    )
                conn.commit()
                return row is not None
        except Exception:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            conn.close()

    def batch_delete_questions(self, set_id: int, ids: list[int]) -> int:
        """Atomically delete questions by db_ids in a single query."""
        if not ids:
            return 0

        parsed_ids: list[int] = []
        for i in ids:
            try:
                parsed_ids.append(int(i))
            except (ValueError, TypeError):
                pass
        ids_clean = list(dict.fromkeys(parsed_ids))

        if len(ids_clean) > MAX_BATCH_DELETE_ITEMS:
            raise ValueError(
                f"Batch delete payload exceeds limit of {MAX_BATCH_DELETE_ITEMS:,} items."
            )

        if not ids_clean:
            return 0

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM questions
                    WHERE question_set_id = %s AND id = ANY(%s)
                    RETURNING id;
                    """,
                    (set_id, ids_clean),
                )
                deleted_rows = cur.fetchall()
                deleted_count = len(deleted_rows)
                if deleted_count > 0:
                    cur.execute(
                        TOUCH_QUESTION_SET_UPDATED_AT_SQL,
                        (set_id,),
                    )
                conn.commit()
                return deleted_count
        except Exception:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            conn.close()
