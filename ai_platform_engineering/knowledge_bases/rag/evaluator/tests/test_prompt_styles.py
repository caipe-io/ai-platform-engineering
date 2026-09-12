from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from deepeval_eval.api.auth import (
    Role,
    UserContext,
    authorize_prompt_style_access,
    check_resource_visibility,
    require_role,
)
from deepeval_eval.api.prompt_styles import (
    PromptStyleCreate,
    PromptStyleUpdate,
    create_prompt_style,
    delete_prompt_style,
)
from deepeval_eval.api.prompt_styles import (
    get_prompt_style as get_prompt_style_endpoint,
)
from deepeval_eval.api.prompt_styles import (
    list_prompt_styles as list_prompt_styles_endpoint,
)
from deepeval_eval.api.prompt_styles import (
    update_prompt_style as update_prompt_style_endpoint,
)
from deepeval_eval.core.prompt_style import (
    build_agentic_prompt,
    build_prompt,
)
from deepeval_eval.db.prompt_db_manager import PromptDBManager

# ============================================================================
# 1. Tests for check_resource_visibility and authorize_prompt_style_access
# ============================================================================


def test_check_resource_visibility_public_positive():
    assert (
        check_resource_visibility(
            resource_visibility="public",
            owner_id="user_a",
            owner_team="team_a",
            user_id="user_b",
            user_teams=["team_b"],
        )
        is True
    )


def test_check_resource_visibility_system_override():
    assert (
        check_resource_visibility(
            resource_visibility="private",
            owner_id="user_a",
            owner_team="team_a",
            user_id="user_b",
            user_teams=[],
            is_system=True,
        )
        is True
    )


def test_check_resource_visibility_team_match_positive():
    assert (
        check_resource_visibility(
            resource_visibility="team",
            owner_id="user_a",
            owner_team="team_a",
            user_id="user_b",
            user_teams=["team_a", "team_b"],
        )
        is True
    )


def test_check_resource_visibility_team_mismatch_negative():
    assert (
        check_resource_visibility(
            resource_visibility="team",
            owner_id="user_a",
            owner_team="team_a",
            user_id="user_b",
            user_teams=["team_b"],
        )
        is False
    )


def test_check_resource_visibility_private_owner_positive():
    assert (
        check_resource_visibility(
            resource_visibility="private",
            owner_id="user_a",
            owner_team="team_a",
            user_id="user_a",
            user_teams=["team_a"],
        )
        is True
    )


def test_check_resource_visibility_private_non_owner_negative():
    assert (
        check_resource_visibility(
            resource_visibility="private",
            owner_id="user_a",
            owner_team="team_a",
            user_id="user_b",
            user_teams=["team_a"],
        )
        is False
    )


def test_check_resource_visibility_admin_override():
    assert (
        check_resource_visibility(
            resource_visibility="private",
            owner_id="user_a",
            owner_team="team_a",
            user_id="user_b",
            user_teams=[],
            is_admin=True,
        )
        is True
    )


def test_authorize_prompt_style_access_system_style_read_positive():
    user = UserContext(
        subject="user_b",
        email="user_b@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )
    system_style = {"name": "generation", "is_system": True, "visibility": "public"}
    authorize_prompt_style_access(user, system_style, scope="read")


def test_authorize_prompt_style_access_system_style_manage_negative():
    user = UserContext(
        subject="user_b",
        email="user_b@example.com",
        role=Role.EVALUATOR,
        is_authenticated=True,
    )
    system_style = {"name": "generation", "is_system": True, "visibility": "public"}
    with pytest.raises(HTTPException) as exc_info:
        authorize_prompt_style_access(user, system_style, scope="manage")
    assert exc_info.value.status_code == 403
    assert "read-only" in str(exc_info.value.detail)


def test_authorize_prompt_style_access_denied_negative():
    user = UserContext(
        subject="user_b",
        email="user_b@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )
    private_style = {
        "name": "secret_style",
        "is_system": False,
        "visibility": "private",
        "owner_id": "user_a",
    }
    with pytest.raises(HTTPException) as exc_info:
        authorize_prompt_style_access(user, private_style, scope="read")
    assert exc_info.value.status_code == 403
    assert "Access denied" in str(exc_info.value.detail)


# ============================================================================
# 2. Tests for build_prompt and build_agentic_prompt
# ============================================================================


def test_build_agentic_prompt_default_positive():
    question = "What is CAIPE architecture?"
    formatted = build_agentic_prompt(style=None, question=question)
    assert formatted == question


def test_build_agentic_prompt_custom_template_positive():
    question = "What is CAIPE architecture?"
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "template": "Analyze the question:\n{question}"
    }

    formatted = build_agentic_prompt(
        style="custom_agentic", question=question, db_manager=mock_db
    )
    assert formatted == "Analyze the question:\nWhat is CAIPE architecture?"


def test_build_agentic_prompt_unknown_style_negative():
    question = "What is CAIPE?"
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = None
    formatted = build_agentic_prompt(
        style="non_existent_style", question=question, db_manager=mock_db
    )
    assert formatted == question


def test_build_prompt_generation_positive():
    question = "What is RAG?"
    contexts = ["RAG stands for Retrieval-Augmented Generation."]
    formatted = build_prompt(style="generation", question=question, contexts=contexts)
    assert "Question:\nWhat is RAG?" in formatted
    assert "[1] RAG stands for Retrieval-Augmented Generation." in formatted


def test_build_prompt_short_enum_positive():
    question = "Who wrote python?"
    contexts = ["Guido van Rossum created Python."]
    formatted = build_prompt(style="short", question=question, contexts=contexts)
    assert "Keep the answer short" in formatted


def test_build_prompt_db_fallback_positive():
    question = "What is OpenFGA?"
    contexts = ["OpenFGA is a fine-grained authorization engine."]
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "template": "Custom Template:\nQuestion: {question}\nContext:\n{context}"
    }
    formatted = build_prompt(
        style="custom_db_style",
        question=question,
        contexts=contexts,
        db_manager=mock_db,
    )
    assert "Custom Template:" in formatted
    assert "Question: What is OpenFGA?" in formatted


def test_build_prompt_unknown_style_negative():
    question = "Invalid test"
    contexts = []
    with pytest.raises(ValueError) as exc_info:
        build_prompt(
            style="totally_unknown_style", question=question, contexts=contexts
        )
    assert "Unknown prompt style: 'totally_unknown_style'" in str(exc_info.value)


# ============================================================================
# 3. Tests for PromptDBManager (DB Layer)
# ============================================================================


def test_prompt_db_manager_init_tables_positive():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    mock_db.get_connection.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur

    manager = PromptDBManager(mock_db)
    manager.init_tables()

    assert cur.execute.call_count >= 2
    assert conn.commit.call_count >= 2


def test_prompt_db_manager_init_tables_exception_rollback():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    cur.execute.side_effect = Exception("DB Connection Lost")
    mock_db.get_connection.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur

    manager = PromptDBManager(mock_db)
    with pytest.raises(Exception) as exc_info:
        manager.init_tables()
    assert "DB Connection Lost" in str(exc_info.value)
    conn.rollback.assert_called_once()


def test_prompt_db_manager_upsert_exception_rollback():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    cur.execute.side_effect = Exception("Unique Constraint Failed")
    mock_db.get_connection.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur

    manager = PromptDBManager(mock_db)
    with pytest.raises(Exception) as exc_info:
        manager.upsert_prompt_style(name="failed_style", template="{question}")
    assert "Unique Constraint Failed" in str(exc_info.value)
    conn.rollback.assert_called_once()


def test_prompt_db_manager_delete_exception_rollback():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    cur.execute.side_effect = Exception("DB Delete Error")
    mock_db.get_connection.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur

    manager = PromptDBManager(mock_db)
    with pytest.raises(Exception) as exc_info:
        manager.delete_prompt_style("failed_style")
    assert "DB Delete Error" in str(exc_info.value)
    conn.rollback.assert_called_once()


def test_prompt_db_manager_non_postgres_handling():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = False
    manager = PromptDBManager(mock_db)

    # Should safely return without executing
    manager.init_tables()
    assert manager.get_prompt_style("test") is None
    assert manager.list_prompt_styles() == ([], 0)
    assert manager.delete_prompt_style("test") is False
    with pytest.raises(RuntimeError) as exc_info:
        manager.upsert_prompt_style(name="test", template="{question}")
    assert "PostgreSQL DB is required" in str(exc_info.value)


def test_prompt_db_manager_upsert_and_get_positive():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    mock_db.get_connection.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur

    now = datetime.now(UTC)
    mock_row = (
        "custom_style",
        "Custom description",
        "generation",
        "Template: {question}",
        "private",
        "user_123",
        "team_dev",
        False,
        now,
        now,
    )
    cur.fetchone.return_value = mock_row

    manager = PromptDBManager(mock_db)
    result = manager.upsert_prompt_style(
        name="custom_style",
        template="Template: {question}",
        description="Custom description",
        visibility="private",
        owner_id="user_123",
        owner_team="team_dev",
    )

    assert result["name"] == "custom_style"
    assert result["template"] == "Template: {question}"
    assert result["visibility"] == "private"


def test_prompt_db_manager_list_positive():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    mock_db.get_connection.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur

    now = datetime.now(UTC)
    cur.fetchone.return_value = (1,)  # total count
    cur.fetchall.return_value = [
        (
            "gen_style",
            "Desc",
            "generation",
            "{question}",
            "public",
            "user_a",
            "team_a",
            True,
            now,
            now,
        )
    ]

    manager = PromptDBManager(mock_db)
    items, total = manager.list_prompt_styles(
        user_id="user_a", user_teams=["team_a"], is_admin=False
    )

    assert total == 1
    assert len(items) == 1
    assert items[0]["name"] == "gen_style"


def test_prompt_db_manager_delete_positive():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    mock_db.get_connection.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur
    cur.fetchone.return_value = ("custom_style",)

    manager = PromptDBManager(mock_db)
    deleted = manager.delete_prompt_style("custom_style")
    assert deleted is True


# ============================================================================
# 4. Tests for REST API Endpoints (prompt_styles.py)
# ============================================================================


@pytest.mark.asyncio
async def test_endpoint_list_prompt_styles_positive():
    mock_db = MagicMock()
    now = datetime.now(UTC).isoformat()
    mock_db.prompt_styles.list_prompt_styles.return_value = (
        [
            {
                "name": "generation",
                "description": "Default",
                "style_type": "generation",
                "template": "{question}",
                "visibility": "public",
                "owner_id": None,
                "owner_team": None,
                "is_system": True,
                "created_at": now,
                "updated_at": now,
            }
        ],
        1,
    )
    user = UserContext(
        subject="user_1",
        email="u1@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )

    response = await list_prompt_styles_endpoint(
        style_type=None, page=1, limit=50, user=user, db=mock_db
    )
    assert response.total == 1
    assert response.items[0].name == "generation"


@pytest.mark.asyncio
async def test_endpoint_get_prompt_style_not_found_negative():
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = None
    user = UserContext(
        subject="user_1",
        email="u1@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )

    with pytest.raises(HTTPException) as exc_info:
        await get_prompt_style_endpoint(name="non_existent", user=user, db=mock_db)
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_endpoint_create_prompt_style_conflict_negative():
    mock_db = MagicMock()
    now = datetime.now(UTC).isoformat()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "name": "existing_style",
        "template": "{question}",
        "created_at": now,
        "updated_at": now,
    }
    user = UserContext(
        subject="user_1",
        email="u1@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )

    payload = PromptStyleCreate(
        name="existing_style",
        template="{question}",
        visibility="private",
    )

    with pytest.raises(HTTPException) as exc_info:
        await create_prompt_style(payload=payload, user=user, db=mock_db)
    assert exc_info.value.status_code == 409
    assert "already exists" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_endpoint_create_prompt_style_positive():
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = None
    now = datetime.now(UTC).isoformat()
    mock_db.prompt_styles.upsert_prompt_style.return_value = {
        "name": "new_style",
        "description": "New style desc",
        "style_type": "generation",
        "template": "Answer: {question}",
        "visibility": "private",
        "owner_id": "user_1",
        "owner_team": None,
        "is_system": False,
        "created_at": now,
        "updated_at": now,
    }
    user = UserContext(
        subject="user_1",
        email="u1@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )

    payload = PromptStyleCreate(
        name="new_style",
        description="New style desc",
        template="Answer: {question}",
        visibility="private",
    )

    response = await create_prompt_style(payload=payload, user=user, db=mock_db)
    assert response.name == "new_style"
    assert response.template == "Answer: {question}"


@pytest.mark.asyncio
async def test_endpoint_update_prompt_style_positive():
    mock_db = MagicMock()
    now = datetime.now(UTC).isoformat()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "name": "my_style",
        "description": "Old desc",
        "style_type": "generation",
        "template": "Old: {question}",
        "visibility": "private",
        "owner_id": "user_1",
        "owner_team": None,
        "is_system": False,
        "created_at": now,
        "updated_at": now,
    }
    mock_db.prompt_styles.upsert_prompt_style.return_value = {
        "name": "my_style",
        "description": "Updated desc",
        "style_type": "generation",
        "template": "Updated: {question}",
        "visibility": "public",
        "owner_id": "user_1",
        "owner_team": None,
        "is_system": False,
        "created_at": now,
        "updated_at": now,
    }
    user = UserContext(
        subject="user_1",
        email="u1@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )

    payload = PromptStyleUpdate(
        description="Updated desc",
        template="Updated: {question}",
        visibility="public",
    )

    response = await update_prompt_style_endpoint(
        name="my_style", payload=payload, user=user, db=mock_db
    )
    assert response.description == "Updated desc"
    assert response.visibility == "public"


@pytest.mark.asyncio
async def test_endpoint_delete_prompt_style_positive():
    mock_db = MagicMock()
    now = datetime.now(UTC).isoformat()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "name": "my_style",
        "is_system": False,
        "visibility": "private",
        "owner_id": "user_1",
        "created_at": now,
        "updated_at": now,
    }
    mock_db.prompt_styles.delete_prompt_style.return_value = True

    user = UserContext(
        subject="user_1",
        email="u1@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )

    await delete_prompt_style(name="my_style", user=user, db=mock_db)


@pytest.mark.asyncio
async def test_require_role_admin_blocks_non_admin_users():
    """Verify require_role(Role.ADMIN) blocks non-admin users with 403 Forbidden."""
    admin_checker = require_role(Role.ADMIN)

    evaluator_user = UserContext(
        subject="user_eval",
        email="eval@example.com",
        role=Role.EVALUATOR,
        is_authenticated=True,
    )
    readonly_user = UserContext(
        subject="user_ro",
        email="ro@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )

    with patch(
        "deepeval_eval.api.auth._openfga_check_org_admin",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(HTTPException) as exc_eval:
            await admin_checker(user=evaluator_user)
        assert exc_eval.value.status_code == 403
        assert "admin" in str(exc_eval.value.detail).lower()

        with pytest.raises(HTTPException) as exc_ro:
            await admin_checker(user=readonly_user)
        assert exc_ro.value.status_code == 403
        assert "admin" in str(exc_ro.value.detail).lower()


@pytest.mark.asyncio
async def test_require_role_admin_allows_admin_user():
    """Verify require_role(Role.ADMIN) allows admin users."""
    admin_checker = require_role(Role.ADMIN)

    admin_user = UserContext(
        subject="admin_1",
        email="admin@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )

    result = await admin_checker(user=admin_user)
    assert result.role == Role.ADMIN
    assert result.email == "admin@example.com"


def test_get_db_manager_when_invoked_returns_database_manager_instance() -> None:
    from deepeval_eval.api.prompt_styles import _get_db_manager
    from deepeval_eval.db.db_manager import DatabaseManager

    db = _get_db_manager()
    assert isinstance(db, DatabaseManager)


@pytest.mark.asyncio
async def test_get_prompt_style_when_style_exists_and_authorized_returns_prompt_style_response() -> (
    None
):
    from deepeval_eval.api.prompt_styles import get_prompt_style

    mock_db = MagicMock()
    now = datetime.now(UTC).isoformat()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "name": "standard_style",
        "description": "Standard prompt style",
        "style_type": "generation",
        "template": "Answer: {question}",
        "visibility": "public",
        "owner_id": "example_user",
        "owner_team": None,
        "is_system": False,
        "created_at": now,
        "updated_at": now,
    }
    user = UserContext(
        subject="example_user",
        email="example_user@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )

    with patch(
        "deepeval_eval.api.prompt_styles.authorize_prompt_style_access"
    ) as mock_authz:
        response = await get_prompt_style(name="standard_style", user=user, db=mock_db)
        mock_authz.assert_called_once()
        assert response.name == "standard_style"
        assert response.template == "Answer: {question}"


@pytest.mark.asyncio
async def test_update_prompt_style_when_style_not_found_raises_not_found_exception() -> (
    None
):
    from deepeval_eval.api.prompt_styles import update_prompt_style

    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = None
    user = UserContext(
        subject="admin_user",
        email="admin@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )
    payload = PromptStyleUpdate(description="Updated desc")

    with pytest.raises(HTTPException) as exc_info:
        await update_prompt_style(
            name="missing_style", payload=payload, user=user, db=mock_db
        )
    assert exc_info.value.status_code == 404
    assert "not found" in str(exc_info.value.detail).lower()


@pytest.mark.asyncio
async def test_delete_prompt_style_when_style_not_found_raises_not_found_exception() -> (
    None
):
    from deepeval_eval.api.prompt_styles import delete_prompt_style

    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = None
    user = UserContext(
        subject="admin_user",
        email="admin@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )

    with pytest.raises(HTTPException) as exc_info:
        await delete_prompt_style(name="missing_style", user=user, db=mock_db)
    assert exc_info.value.status_code == 404
    assert "not found" in str(exc_info.value.detail).lower()


@pytest.mark.asyncio
async def test_delete_prompt_style_when_deletion_fails_raises_bad_request_exception() -> (
    None
):
    from deepeval_eval.api.prompt_styles import delete_prompt_style

    mock_db = MagicMock()
    now = datetime.now(UTC).isoformat()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "name": "locked_style",
        "is_system": False,
        "visibility": "private",
        "owner_id": "admin_user",
        "created_at": now,
        "updated_at": now,
    }
    mock_db.prompt_styles.delete_prompt_style.return_value = False
    user = UserContext(
        subject="admin_user",
        email="admin@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )

    with patch("deepeval_eval.api.prompt_styles.authorize_prompt_style_access"):
        with pytest.raises(HTTPException) as exc_info:
            await delete_prompt_style(name="locked_style", user=user, db=mock_db)
        assert exc_info.value.status_code == 400
        assert "failed to delete" in str(exc_info.value.detail).lower()


def test_prompt_db_manager_get_prompt_style_when_exception_occurs_returns_none() -> (
    None
):
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    cur.execute.side_effect = Exception("DB Read Failure")
    conn.cursor.return_value.__enter__.return_value = cur
    mock_db.get_connection.return_value = conn

    manager = PromptDBManager(mock_db)
    result = manager.get_prompt_style("some_style")
    assert result is None


def test_prompt_db_manager_list_prompt_styles_when_exception_occurs_returns_empty_tuple() -> (
    None
):
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    conn = MagicMock()
    cur = MagicMock()
    cur.execute.side_effect = Exception("DB List Failure")
    conn.cursor.return_value.__enter__.return_value = cur
    mock_db.get_connection.return_value = conn

    manager = PromptDBManager(mock_db)
    items, total = manager.list_prompt_styles()
    assert items == []
    assert total == 0
