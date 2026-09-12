from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from deepeval_eval.core.prompt_style import BUILTIN_PROMPT_TEMPLATES

if TYPE_CHECKING:
    from deepeval_eval.db.db_manager import DatabaseManager

logger = logging.getLogger(__name__)


class PromptDBManager:
    """PostgreSQL database manager for Prompt Styles with App-Level Visibility Filtering."""

    def __init__(self, db_manager: DatabaseManager) -> None:
        self.db_manager = db_manager

    def init_tables(self) -> None:
        """Initialize PostgreSQL schema for prompt_styles table and seed system defaults."""
        if not self.db_manager.is_postgres():
            return

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS prompt_styles (
                        name         VARCHAR(100) PRIMARY KEY,
                        description  TEXT,
                        style_type   VARCHAR(50) NOT NULL DEFAULT 'generation',
                        template     TEXT NOT NULL,
                        visibility   VARCHAR(20) NOT NULL DEFAULT 'public',
                        owner_id     VARCHAR(100),
                        owner_team   VARCHAR(100),
                        is_system    BOOLEAN NOT NULL DEFAULT false,
                        created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                        updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                    );

                    CREATE INDEX IF NOT EXISTS idx_prompt_styles_visibility 
                        ON prompt_styles(visibility, owner_team, owner_id);
                    CREATE INDEX IF NOT EXISTS idx_prompt_styles_type 
                        ON prompt_styles(style_type);
                    """
                )
            conn.commit()
            self._seed_default_prompt_styles(conn)
        except Exception as exc:
            conn.rollback()
            logger.exception(f"Failed to initialize prompt_styles table: {exc}")
            raise

    def _seed_default_prompt_styles(self, conn: Any) -> None:
        """Seed built-in public system prompt styles into the database."""
        default_styles = [
            (
                "generation",
                "Standard post-retrieval LLM answer generation prompt",
                "generation",
                BUILTIN_PROMPT_TEMPLATES["generation"],
                "public",
                None,
                None,
                True,
            ),
            (
                "short",
                "Concise short answer prompt for benchmark evaluations",
                "generation",
                BUILTIN_PROMPT_TEMPLATES["short"],
                "public",
                None,
                None,
                True,
            ),
            (
                "agentic_generation",
                "Standard pre-retrieval instruction for Agentic mode queries",
                "agentic",
                BUILTIN_PROMPT_TEMPLATES["agentic_generation"],
                "public",
                None,
                None,
                True,
            ),
            (
                "agentic_short",
                "Concise pre-retrieval instruction for Agentic mode queries",
                "agentic",
                BUILTIN_PROMPT_TEMPLATES["agentic_short"],
                "public",
                None,
                None,
                True,
            ),
        ]

        with conn.cursor() as cur:
            for (
                name,
                desc,
                style_type,
                template,
                vis,
                o_id,
                o_team,
                is_sys,
            ) in default_styles:
                cur.execute(
                    """
                    INSERT INTO prompt_styles 
                        (name, description, style_type, template, visibility, owner_id, owner_team, is_system)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (name) DO NOTHING;
                    """,
                    (name, desc, style_type, template, vis, o_id, o_team, is_sys),
                )
        conn.commit()

    def upsert_prompt_style(
        self,
        name: str,
        template: str,
        style_type: str = "generation",
        description: str | None = None,
        visibility: str = "private",
        owner_id: str | None = None,
        owner_team: str | None = None,
        is_system: bool = False,
    ) -> dict[str, Any]:
        """Insert or update a prompt style record."""
        if not self.db_manager.is_postgres():
            raise RuntimeError("PostgreSQL DB is required for prompt style persistence")

        clean_name = name.strip().lower()
        clean_vis = (visibility or "private").strip().lower()
        clean_type = (style_type or "generation").strip().lower()

        conn = self.db_manager.get_connection()
        now = datetime.now(UTC)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO prompt_styles (
                        name, description, style_type, template, visibility, 
                        owner_id, owner_team, is_system, created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (name) DO UPDATE SET
                        description = EXCLUDED.description,
                        style_type = EXCLUDED.style_type,
                        template = EXCLUDED.template,
                        visibility = EXCLUDED.visibility,
                        owner_id = COALESCE(EXCLUDED.owner_id, prompt_styles.owner_id),
                        owner_team = COALESCE(EXCLUDED.owner_team, prompt_styles.owner_team),
                        updated_at = EXCLUDED.updated_at
                    RETURNING name, description, style_type, template, visibility, 
                              owner_id, owner_team, is_system, created_at, updated_at;
                    """,
                    (
                        clean_name,
                        description,
                        clean_type,
                        template,
                        clean_vis,
                        owner_id,
                        owner_team,
                        is_system,
                        now,
                        now,
                    ),
                )
                row = cur.fetchone()
            conn.commit()
            return self._row_to_dict(row)
        except Exception as exc:
            conn.rollback()
            logger.exception(f"Failed to upsert prompt style '{clean_name}': {exc}")
            raise

    def get_prompt_style(self, name: str) -> dict[str, Any] | None:
        """Fetch prompt style by name."""
        if not self.db_manager.is_postgres():
            return None

        clean_name = name.strip().lower()
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT name, description, style_type, template, visibility, 
                           owner_id, owner_team, is_system, created_at, updated_at
                    FROM prompt_styles
                    WHERE name = %s;
                    """,
                    (clean_name,),
                )
                row = cur.fetchone()
            return self._row_to_dict(row) if row else None
        except Exception as exc:
            logger.warning(f"Error fetching prompt style '{clean_name}': {exc}")
            return None

    def list_prompt_styles(
        self,
        user_id: str | None = None,
        user_teams: list[str] | set[str] | None = None,
        is_admin: bool = False,
        style_type: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """List prompt styles accessible to the user based on App-Level Visibility filtering."""
        if not self.db_manager.is_postgres():
            return ([], 0)

        teams_list = list(user_teams) if user_teams else []
        clean_type = style_type.strip().lower() if style_type else None

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                # Construct visibility filter clause
                visibility_filter = """
                    (is_system = TRUE
                     OR %s = TRUE
                     OR visibility = 'public'
                     OR (visibility = 'team' AND owner_team = ANY(%s))
                     OR (visibility = 'private' AND owner_id = %s))
                """

                type_filter = "AND (%s::text IS NULL OR style_type = %s)"

                where_clause = f"WHERE {visibility_filter} {type_filter}"

                # Count total items
                cur.execute(
                    f"SELECT COUNT(*) FROM prompt_styles {where_clause};",
                    (is_admin, teams_list, user_id, clean_type, clean_type),
                )
                total = cur.fetchone()[0]

                # Fetch paginated items
                cur.execute(
                    f"""
                    SELECT name, description, style_type, template, visibility, 
                           owner_id, owner_team, is_system, created_at, updated_at
                    FROM prompt_styles
                    {where_clause}
                    ORDER BY is_system DESC, name ASC
                    LIMIT %s OFFSET %s;
                    """,
                    (
                        is_admin,
                        teams_list,
                        user_id,
                        clean_type,
                        clean_type,
                        limit,
                        offset,
                    ),
                )
                rows = cur.fetchall()

            items = [self._row_to_dict(row) for row in rows]
            return (items, total)
        except Exception as exc:
            logger.exception(f"Failed to list prompt styles: {exc}")
            return ([], 0)

    def delete_prompt_style(self, name: str) -> bool:
        """Delete custom prompt style by name (cannot delete system prompt styles)."""
        if not self.db_manager.is_postgres():
            return False

        clean_name = name.strip().lower()
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM prompt_styles 
                    WHERE name = %s AND is_system = FALSE
                    RETURNING name;
                    """,
                    (clean_name,),
                )
                deleted = cur.fetchone()
            conn.commit()
            return bool(deleted)
        except Exception as exc:
            conn.rollback()
            logger.exception(f"Failed to delete prompt style '{clean_name}': {exc}")
            raise

    def _row_to_dict(self, row: tuple) -> dict[str, Any]:
        """Convert database tuple to clean dictionary."""
        return {
            "name": row[0],
            "description": row[1],
            "style_type": row[2],
            "template": row[3],
            "visibility": row[4],
            "owner_id": row[5],
            "owner_team": row[6],
            "is_system": row[7],
            "created_at": row[8].isoformat()
            if hasattr(row[8], "isoformat")
            else str(row[8]),
            "updated_at": row[9].isoformat()
            if hasattr(row[9], "isoformat")
            else str(row[9]),
        }
