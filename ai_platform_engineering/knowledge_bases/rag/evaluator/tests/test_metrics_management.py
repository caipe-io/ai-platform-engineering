from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from deepeval.metrics import (
    FaithfulnessMetric,
    GEval,
)
from deepeval.models.base_model import DeepEvalBaseLLM
from deepeval.test_case import SingleTurnParams
from fastapi import HTTPException

from deepeval_eval.api.auth import (
    Role,
    UserContext,
    authorize_metric_access,
    authorize_metric_set_access,
)
from deepeval_eval.api.metric_sets import (
    MetricSetCreate,
    MetricSetItemCreate,
    MetricSetUpdate,
)
from deepeval_eval.api.metric_sets import (
    create_metric_set as create_metric_set_endpoint,
)
from deepeval_eval.api.metric_sets import (
    delete_metric_set as delete_metric_set_endpoint,
)
from deepeval_eval.api.metric_sets import (
    get_metric_set as get_metric_set_endpoint,
)
from deepeval_eval.api.metric_sets import (
    list_metric_sets as list_metric_sets_endpoint,
)
from deepeval_eval.api.metric_sets import (
    update_metric_set as update_metric_set_endpoint,
)
from deepeval_eval.api.metrics import (
    MetricCreate,
    MetricUpdate,
)
from deepeval_eval.api.metrics import (
    create_metric as create_metric_endpoint,
)
from deepeval_eval.api.metrics import (
    delete_metric as delete_metric_endpoint,
)
from deepeval_eval.api.metrics import (
    get_metric as get_metric_endpoint,
)
from deepeval_eval.api.metrics import (
    list_builtin_metrics as list_builtin_metrics_endpoint,
)
from deepeval_eval.api.metrics import (
    list_metrics as list_metrics_endpoint,
)
from deepeval_eval.api.metrics import (
    update_metric as update_metric_endpoint,
)
from deepeval_eval.db.db_manager import DatabaseManager
from deepeval_eval.db.metric_db_manager import MetricDBManager
from deepeval_eval.engine.metrics import (
    MRRMetric,
    RetrievalRecallMetric,
    build_metric_instance,
    build_metrics_from_config,
    list_builtin_metric_metadata,
)


class DummyJudge(DeepEvalBaseLLM):
    def __init__(self):
        super().__init__(model="test")

    def load_model(self, *args, **kwargs):
        return None

    def get_model_name(self, *args, **kwargs) -> str:
        return "dummy-judge"

    def generate(self, prompt: str, schema=None, **kwargs) -> str:
        return ""

    async def a_generate(self, prompt: str, schema=None, **kwargs) -> str:
        return ""


# ============================================================================
# 1. Tests for Engine Metric Factory & Registry
# ============================================================================


def test_builtin_metrics_registry_contains_all_deepeval_metrics_classes():
    import inspect

    import deepeval.metrics

    from deepeval_eval.engine.metrics import BUILTIN_METRICS_REGISTRY

    # Inspect all BaseMetric subclasses exported by deepeval.metrics
    deepeval_classes = {
        obj
        for _, obj in inspect.getmembers(deepeval.metrics)
        if inspect.isclass(obj)
        and issubclass(obj, deepeval.metrics.BaseMetric)
        and obj is not deepeval.metrics.BaseMetric
    }

    registered_classes = set(BUILTIN_METRICS_REGISTRY.values())

    # Every deepeval.metrics class must be registered in BUILTIN_METRICS_REGISTRY
    for cls in deepeval_classes:
        assert cls in registered_classes, (
            f"deepeval.metrics class {cls.__name__} is missing from BUILTIN_METRICS_REGISTRY"
        )


def test_list_builtin_metric_metadata_includes_all_registered_deepeval_metrics():
    metadata = list_builtin_metric_metadata()
    assert isinstance(metadata, list)
    # 33 deepeval classes + repo custom code metrics
    assert len(metadata) >= 35
    names = {m["name"] for m in metadata}
    # Check diverse deepeval metrics across categories
    assert "hallucination" in names
    assert "toxicity" in names
    assert "bias" in names
    assert "summarization" in names
    assert "json_correctness" in names
    assert "tool_correctness" in names
    assert "mcp_use" in names
    assert "faithfulness" in names
    assert "mrr" in names
    assert "ndcg_at_k" in names


def test_build_metric_instance_additional_deepeval_metrics_success():
    from deepeval.metrics import ExactMatchMetric, HallucinationMetric, ToxicityMetric

    judge = DummyJudge()

    # 1. Hallucination Metric
    h_metric = build_metric_instance({"name": "hallucination", "threshold": 0.6}, judge)
    assert isinstance(h_metric, HallucinationMetric)
    assert h_metric.threshold == 0.6

    # 2. Toxicity Metric
    tox_metric = build_metric_instance({"name": "toxicity", "threshold": 0.4}, judge)
    assert isinstance(tox_metric, ToxicityMetric)
    assert tox_metric.threshold == 0.4

    # 3. ExactMatchMetric (deterministic / non-judge)
    em_metric = build_metric_instance({"name": "exact_match", "threshold": 1.0}, judge)
    assert isinstance(em_metric, ExactMatchMetric)


def test_list_builtin_metric_metadata_valid_return_list():
    metadata = list_builtin_metric_metadata()
    assert isinstance(metadata, list)
    assert len(metadata) >= 12
    names = {m["name"] for m in metadata}
    assert "faithfulness" in names
    assert "answer_relevancy" in names
    assert "mrr" in names
    assert "ndcg_at_k" in names
    assert "normalized_exact_match" in names


def test_build_metric_instance_builtin_custom_threshold_success():
    judge = DummyJudge()
    cfg = {
        "name": "faithfulness",
        "metric_type": "builtin",
        "threshold": 0.85,
        "parameters": {"include_reason": True, "strict_mode": False},
    }
    metric = build_metric_instance(cfg, judge)
    assert isinstance(metric, FaithfulnessMetric)
    assert metric.threshold == 0.85


def test_build_metric_instance_custom_code_success():
    judge = DummyJudge()
    cfg = {
        "name": "mrr",
        "metric_type": "custom_code",
        "threshold": 0.7,
        "parameters": {},
    }
    metric = build_metric_instance(cfg, judge)
    assert isinstance(metric, MRRMetric)
    assert metric.threshold == 0.7


def test_build_metric_instance_geval_dynamic_criteria_success():
    judge = DummyJudge()
    cfg = {
        "name": "conciseness",
        "metric_type": "g_eval",
        "threshold": 0.8,
        "evaluation_params": ["input", "actual_output"],
        "criteria": "Evaluate whether the answer is concise and directly addresses the question without fluff.",
        "evaluation_steps": [
            "Check if there is fluff.",
            "Score 1.0 if concise, else 0.0.",
        ],
    }
    metric = build_metric_instance(cfg, judge)
    assert isinstance(metric, GEval)
    assert metric.name == "conciseness"
    assert metric.threshold == 0.8
    assert SingleTurnParams.INPUT in metric.evaluation_params
    assert SingleTurnParams.ACTUAL_OUTPUT in metric.evaluation_params


def test_build_metric_instance_unknown_type_raises_value_error():
    judge = DummyJudge()
    cfg = {"name": "invalid", "metric_type": "nonexistent"}
    with pytest.raises(ValueError, match="Unsupported metric type"):
        build_metric_instance(cfg, judge)


def test_build_metrics_from_config_selective_filter_returns_selected_subset():
    judge = DummyJudge()
    metrics = build_metrics_from_config(
        metric_names=["faithfulness", "mrr"],
        metric_set_name=None,
        judge_model=judge,
        db=None,
    )
    assert len(metrics) == 2
    assert any(isinstance(m, FaithfulnessMetric) for m in metrics)
    assert any(isinstance(m, MRRMetric) for m in metrics)


def test_build_metrics_from_config_resolves_metric_set_from_db():
    judge = DummyJudge()
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_db.metrics.get_metric_set_with_metrics.return_value = {
        "name": "fast_retrieval",
        "metrics": [
            {"name": "mrr", "metric_type": "custom_code", "threshold": 0.6},
            {
                "name": "retrieval_recall",
                "metric_type": "custom_code",
                "threshold": 0.5,
            },
        ],
    }
    metrics = build_metrics_from_config(
        metric_names=None,
        metric_set_name="fast_retrieval",
        judge_model=judge,
        db=mock_db,
    )
    assert len(metrics) == 2
    assert any(isinstance(m, MRRMetric) for m in metrics)
    assert any(isinstance(m, RetrievalRecallMetric) for m in metrics)


def test_build_metrics_from_config_fallback_to_all_defaults_when_empty():
    judge = DummyJudge()
    metrics = build_metrics_from_config(
        metric_names=None,
        metric_set_name=None,
        judge_model=judge,
        db=None,
    )
    assert len(metrics) == 12


# ============================================================================
# 2. Tests for Auth & Authorization Helpers
# ============================================================================


def test_authorize_metric_access_read_scope_allows_any_authenticated_user():
    user = UserContext(
        subject="user-123",
        role=Role.READONLY,
        email="test@example.com",
    )
    metric_record = {"name": "faithfulness", "is_system": True, "visibility": "public"}
    authorize_metric_access(user, metric_record, scope="read")


def test_authorize_metric_access_manage_scope_rejects_non_admin_raises_403():
    user = UserContext(
        subject="user-123",
        role=Role.EVALUATOR,
        email="test@example.com",
    )
    metric_record = {"name": "faithfulness", "is_system": True, "visibility": "public"}
    with pytest.raises(HTTPException) as exc_info:
        authorize_metric_access(user, metric_record, scope="manage")
    assert exc_info.value.status_code == 403


def test_authorize_metric_access_manage_scope_allows_admin():
    user = UserContext(
        subject="admin-1",
        role=Role.ADMIN,
        email="admin@example.com",
    )
    metric_record = {"name": "custom_geval", "is_system": False, "visibility": "public"}
    authorize_metric_access(user, metric_record, scope="manage")


def test_authorize_metric_set_access_manage_scope_rejects_non_admin_raises_403():
    user = UserContext(
        subject="user-123",
        role=Role.EVALUATOR,
        email="test@example.com",
    )
    metric_set_record = {"name": "rag_core", "is_system": True, "visibility": "public"}
    with pytest.raises(HTTPException) as exc_info:
        authorize_metric_set_access(user, metric_set_record, scope="manage")
    assert exc_info.value.status_code == 403


# ============================================================================
# 3. Tests for MetricDBManager
# ============================================================================


def test_metric_db_manager_init_tables_and_seeds_defaults_success():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_db.get_connection.return_value = mock_conn

    mgr = MetricDBManager(mock_db)
    mgr.init_tables()

    assert mock_cur.execute.called
    assert mock_conn.commit.called


def test_metric_db_manager_upsert_metric_success():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (
        "my_geval",
        "My G-Eval",
        "Description",
        "g_eval",
        None,
        0.75,
        "{}",
        '["input", "actual_output"]',
        "Some criteria",
        '["Step 1"]',
        "public",
        "admin-1",
        None,
        False,
        "2026-08-25T00:00:00Z",
        "2026-08-25T00:00:00Z",
    )
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_db.get_connection.return_value = mock_conn

    mgr = MetricDBManager(mock_db)
    rec = mgr.upsert_metric(
        name="my_geval",
        display_name="My G-Eval",
        description="Description",
        metric_type="g_eval",
        threshold=0.75,
        evaluation_params=["input", "actual_output"],
        criteria="Some criteria",
        evaluation_steps=["Step 1"],
        owner_id="admin-1",
    )
    assert rec["name"] == "my_geval"
    assert rec["threshold"] == 0.75


def test_metric_db_manager_delete_metric_prevents_system_deletion():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (True,)  # is_system = True
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_db.get_connection.return_value = mock_conn

    mgr = MetricDBManager(mock_db)
    with pytest.raises(ValueError, match="System metrics cannot be deleted"):
        mgr.delete_metric("faithfulness")


# ============================================================================
# 4. Tests for REST API Endpoints (/api/v1/metrics)
# ============================================================================


@pytest.mark.asyncio
async def test_list_builtin_metrics_endpoint_returns_catalog():
    res = await list_builtin_metrics_endpoint()
    assert isinstance(res, list)
    assert len(res) >= 12
    assert any(item.name == "faithfulness" for item in res)


@pytest.mark.asyncio
async def test_create_metric_endpoint_rejects_non_geval_creation():
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()
    mock_db.metrics.get_metric.return_value = None

    payload = MetricCreate(
        name="custom_math",
        display_name="Custom Math",
        metric_type="custom_code",  # Invalid for dynamic creation
        threshold=0.5,
    )
    with pytest.raises(HTTPException) as exc_info:
        await create_metric_endpoint(payload, user=admin_user, db=mock_db)
    assert exc_info.value.status_code == 400
    assert "Only 'g_eval' metrics can be dynamically created" in exc_info.value.detail


@pytest.mark.asyncio
async def test_create_metric_endpoint_geval_success():
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()
    mock_db.metrics.get_metric.return_value = None
    mock_db.metrics.upsert_metric.return_value = {
        "name": "safety_check",
        "display_name": "Safety Check",
        "description": "Checks safety",
        "metric_type": "g_eval",
        "metric_class": None,
        "threshold": 0.8,
        "parameters": {},
        "evaluation_params": ["input", "actual_output"],
        "criteria": "Safety criteria",
        "evaluation_steps": ["Step 1"],
        "visibility": "public",
        "owner_id": "admin-1",
        "owner_team": None,
        "is_system": False,
        "created_at": "2026-08-25T00:00:00Z",
        "updated_at": "2026-08-25T00:00:00Z",
    }

    payload = MetricCreate(
        name="safety_check",
        display_name="Safety Check",
        description="Checks safety",
        metric_type="g_eval",
        threshold=0.8,
        evaluation_params=["input", "actual_output"],
        criteria="Safety criteria",
        evaluation_steps=["Step 1"],
    )
    res = await create_metric_endpoint(payload, user=admin_user, db=mock_db)
    assert res.name == "safety_check"
    assert res.threshold == 0.8


@pytest.mark.asyncio
async def test_delete_metric_endpoint_blocks_system_deletion():
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()
    mock_db.metrics.get_metric.return_value = {
        "name": "faithfulness",
        "is_system": True,
    }

    with pytest.raises(HTTPException) as exc_info:
        await delete_metric_endpoint("faithfulness", user=admin_user, db=mock_db)
    assert exc_info.value.status_code == 403
    assert "System metrics are read-only" in exc_info.value.detail


# ============================================================================
# 5. Tests for REST API Endpoints (/api/v1/metric-sets)
# ============================================================================


@pytest.mark.asyncio
async def test_create_metric_set_endpoint_success():
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()
    mock_db.metrics.get_metric_set.return_value = None
    mock_db.metrics.get_metric.return_value = {"name": "faithfulness"}
    mock_db.metrics.upsert_metric_set.return_value = {
        "name": "release_gate",
        "display_name": "Release Gate",
        "description": "Strict release gate",
        "visibility": "public",
        "owner_id": "admin-1",
        "owner_team": None,
        "is_system": False,
        "metrics": [{"metric_name": "faithfulness", "custom_threshold": 0.9}],
        "created_at": "2026-08-25T00:00:00Z",
        "updated_at": "2026-08-25T00:00:00Z",
    }

    payload = MetricSetCreate(
        name="release_gate",
        display_name="Release Gate",
        description="Strict release gate",
        metrics=[MetricSetItemCreate(metric_name="faithfulness", custom_threshold=0.9)],
    )
    res = await create_metric_set_endpoint(payload, user=admin_user, db=mock_db)
    assert res.name == "release_gate"
    assert len(res.metrics) == 1


@pytest.mark.asyncio
async def test_list_metrics_endpoint_success():
    user = UserContext(subject="user-1", role=Role.READONLY, email="user@example.com")
    mock_db = MagicMock()
    mock_db.metrics.list_metrics.return_value = (
        [
            {
                "name": "faithfulness",
                "display_name": "Faithfulness",
                "metric_type": "builtin",
                "threshold": 0.5,
                "is_system": True,
            }
        ],
        1,
    )
    res = await list_metrics_endpoint(page=1, limit=50, user=user, db=mock_db)
    assert res.total == 1
    assert len(res.items) == 1
    assert res.items[0].name == "faithfulness"


@pytest.mark.asyncio
async def test_get_metric_endpoint_found_and_not_found():
    user = UserContext(subject="user-1", role=Role.READONLY, email="user@example.com")
    mock_db = MagicMock()
    mock_db.metrics.get_metric.return_value = {
        "name": "faithfulness",
        "display_name": "Faithfulness",
        "metric_type": "builtin",
        "threshold": 0.5,
        "is_system": True,
    }
    res = await get_metric_endpoint("faithfulness", user=user, db=mock_db)
    assert res.name == "faithfulness"

    mock_db.metrics.get_metric.return_value = None
    with pytest.raises(HTTPException) as exc_info:
        await get_metric_endpoint("nonexistent", user=user, db=mock_db)
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_update_metric_endpoint_success_and_not_found():
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()
    mock_db.metrics.get_metric.return_value = {
        "name": "faithfulness",
        "display_name": "Faithfulness",
        "threshold": 0.5,
        "is_system": True,
    }
    mock_db.metrics.upsert_metric.return_value = {
        "name": "faithfulness",
        "display_name": "Faithfulness Updated",
        "threshold": 0.7,
        "is_system": True,
    }
    update_payload = MetricUpdate(display_name="Faithfulness Updated", threshold=0.7)
    res = await update_metric_endpoint(
        "faithfulness", update_payload, user=admin_user, db=mock_db
    )
    assert res.threshold == 0.7

    mock_db.metrics.get_metric.return_value = None
    with pytest.raises(HTTPException) as exc_info:
        await update_metric_endpoint(
            "nonexistent", update_payload, user=admin_user, db=mock_db
        )
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_list_and_get_metric_sets_endpoint():
    user = UserContext(subject="user-1", role=Role.READONLY, email="user@example.com")
    mock_db = MagicMock()
    mock_db.metrics.list_metric_sets.return_value = (
        [{"name": "rag_core", "display_name": "RAG Core", "is_system": True}],
        1,
    )
    mock_db.metrics.get_metric_set_with_metrics.return_value = {
        "name": "rag_core",
        "display_name": "RAG Core",
        "is_system": True,
        "metrics": [{"name": "faithfulness", "threshold": 0.5}],
    }
    list_res = await list_metric_sets_endpoint(page=1, limit=50, user=user, db=mock_db)
    assert list_res.total == 1
    assert list_res.items[0].name == "rag_core"

    get_res = await get_metric_set_endpoint("rag_core", user=user, db=mock_db)
    assert get_res.name == "rag_core"

    mock_db.metrics.get_metric_set_with_metrics.return_value = None
    with pytest.raises(HTTPException) as exc_info:
        await get_metric_set_endpoint("nonexistent", user=user, db=mock_db)
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_update_and_delete_metric_set_endpoint():
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()
    mock_db.metrics.get_metric_set.return_value = {
        "name": "custom_set",
        "display_name": "Custom Set",
        "is_system": False,
    }
    mock_db.metrics.get_metric.return_value = {"name": "faithfulness"}
    mock_db.metrics.upsert_metric_set.return_value = {
        "name": "custom_set",
        "display_name": "Custom Set Updated",
        "is_system": False,
        "metrics": [{"metric_name": "faithfulness", "custom_threshold": 0.8}],
    }
    mock_db.metrics.delete_metric_set.return_value = True

    update_payload = MetricSetUpdate(
        display_name="Custom Set Updated",
        metrics=[MetricSetItemCreate(metric_name="faithfulness", custom_threshold=0.8)],
    )
    res = await update_metric_set_endpoint(
        "custom_set", update_payload, user=admin_user, db=mock_db
    )
    assert res.display_name == "Custom Set Updated"

    await delete_metric_set_endpoint("custom_set", user=admin_user, db=mock_db)
    mock_db.metrics.delete_metric_set.assert_called_with("custom_set")


def test_metric_db_manager_list_and_get_methods():
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_db.get_connection.return_value = mock_conn

    mgr = MetricDBManager(mock_db)

    # get_metric
    mock_cur.fetchone.return_value = (
        "faithfulness",
        "Faithfulness",
        "Desc",
        "builtin",
        "FaithfulnessMetric",
        0.5,
        "{}",
        "[]",
        None,
        "[]",
        "public",
        None,
        None,
        True,
        "2026-08-25T00:00:00Z",
        "2026-08-25T00:00:00Z",
    )
    metric = mgr.get_metric("faithfulness")
    assert metric["name"] == "faithfulness"

    # list_metrics
    mock_cur.fetchone.return_value = (1,)
    mock_cur.fetchall.return_value = [
        (
            "faithfulness",
            "Faithfulness",
            "Desc",
            "builtin",
            "FaithfulnessMetric",
            0.5,
            "{}",
            "[]",
            None,
            "[]",
            "public",
            None,
            None,
            True,
            "2026-08-25T00:00:00Z",
            "2026-08-25T00:00:00Z",
        )
    ]
    items, total = mgr.list_metrics(metric_type="builtin", page=1, limit=10)
    assert total == 1
    assert len(items) == 1

    # list_metric_sets
    mock_cur.fetchone.return_value = (1,)
    mock_cur.fetchall.return_value = [
        ("rag_core", "RAG Core", "Desc", "public", None, None, True, None, None)
    ]
    sets, total_sets = mgr.list_metric_sets(page=1, limit=10)
    assert total_sets == 1
    assert len(sets) == 1

    # get_metric_set_with_metrics
    mock_cur.fetchone.return_value = (
        "rag_core",
        "RAG Core",
        "Desc",
        "public",
        None,
        None,
        True,
        None,
        None,
    )
    mock_cur.fetchall.return_value = [
        (
            "faithfulness",
            "Faithfulness",
            "Desc",
            "builtin",
            "FaithfulnessMetric",
            0.5,
            "{}",
            "[]",
            None,
            "[]",
            "public",
            None,
            None,
            True,
            None,
            None,
        )
    ]
    set_with_m = mgr.get_metric_set_with_metrics("rag_core")
    assert set_with_m["name"] == "rag_core"
    assert len(set_with_m["metrics"]) == 1


def test_metric_db_manager_upsert_and_delete_operations():
    """Test upsert_metric_set, delete_metric, and delete_metric_set branches."""
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_db.get_connection.return_value = mock_conn

    mgr = MetricDBManager(mock_db)

    # 1. upsert_metric_set with metrics items
    mock_cur.fetchone.return_value = (
        "custom_suite",
        "Custom Suite",
        "Description",
        "public",
        "user1",
        "team1",
        False,
        "2026-08-25T00:00:00Z",
        "2026-08-25T00:00:00Z",
    )
    res = mgr.upsert_metric_set(
        name="custom_suite",
        display_name="Custom Suite",
        description="Description",
        metrics=[{"metric_name": "faithfulness", "custom_threshold": 0.85}],
    )
    assert res["name"] == "custom_suite"
    assert len(res["metrics"]) == 1

    # 2. delete_metric - custom metric
    mock_cur.fetchone.return_value = (False,)  # is_system = False
    mock_cur.rowcount = 1
    deleted = mgr.delete_metric("custom_geval")
    assert deleted is True

    # 3. delete_metric - system metric raises ValueError
    mock_cur.fetchone.return_value = (True,)  # is_system = True
    with pytest.raises(ValueError, match="System metrics cannot be deleted."):
        mgr.delete_metric("faithfulness")

    # 4. delete_metric - not found
    mock_cur.fetchone.return_value = None
    assert mgr.delete_metric("unknown_metric") is False

    # 5. delete_metric_set - custom metric set
    mock_cur.fetchone.return_value = (False,)  # is_system = False
    mock_cur.rowcount = 1
    deleted_set = mgr.delete_metric_set("custom_suite")
    assert deleted_set is True

    # 6. delete_metric_set - system metric set raises ValueError
    mock_cur.fetchone.return_value = (True,)  # is_system = True
    with pytest.raises(ValueError, match="System metric sets cannot be deleted."):
        mgr.delete_metric_set("all_default")

    # 7. delete_metric_set - not found
    mock_cur.fetchone.return_value = None
    assert mgr.delete_metric_set("unknown_set") is False


def test_metric_db_manager_non_postgres_returns_empty_and_graceful_fallbacks():
    """Test MetricDBManager when PostgreSQL is disabled/not configured."""
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = False
    mgr = MetricDBManager(mock_db)

    assert mgr.get_metric("faithfulness") is None
    assert mgr.list_metrics() == ([], 0)
    assert mgr.delete_metric("faithfulness") is False
    assert mgr.get_metric_set("all_default") is None
    assert mgr.get_metric_set_with_metrics("all_default") is None
    assert mgr.list_metric_sets() == ([], 0)
    assert mgr.delete_metric_set("all_default") is False

    with pytest.raises(RuntimeError, match="PostgreSQL is not configured."):
        mgr.upsert_metric("m", "M", "builtin", "FMetric")

    with pytest.raises(RuntimeError, match="PostgreSQL is not configured."):
        mgr.upsert_metric_set("s", "S")


@pytest.mark.asyncio
async def test_update_metric_set_when_metric_not_found_raises_http_400():
    """Verify update_metric_set raises HTTP 400 when bundling a non-existent metric."""
    mock_db = MagicMock()
    mock_db.metrics.get_metric_set.return_value = {
        "name": "target_set",
        "display_name": "Target Set",
        "is_system": False,
    }
    mock_db.metrics.get_metric.return_value = None  # metric does not exist

    admin_user = UserContext(
        subject="admin-1", email="admin@example.com", role=Role.ADMIN, groups=[]
    )
    payload = MetricSetUpdate(metrics=[MetricSetItemCreate(metric_name="ghost_metric")])

    with pytest.raises(HTTPException) as exc_info:
        await update_metric_set_endpoint(
            name="target_set", payload=payload, user=admin_user, db=mock_db
        )
    assert exc_info.value.status_code == 400
    assert "Cannot bundle non-existent metric 'ghost_metric'" in exc_info.value.detail


@pytest.mark.asyncio
async def test_delete_metric_when_system_metric_raises_forbidden_403():
    """Verify delete_metric endpoint converts ValueError from DB manager to HTTP 403 Forbidden."""
    mock_db = MagicMock()
    mock_db.metrics.get_metric.return_value = {
        "name": "custom_metric_err",
        "is_system": False,
    }
    mock_db.metrics.delete_metric.side_effect = ValueError(
        "Metric cannot be deleted due to active dependencies."
    )

    admin_user = UserContext(
        subject="admin-1", email="admin@example.com", role=Role.ADMIN, groups=[]
    )

    with pytest.raises(HTTPException) as exc_info:
        await delete_metric_endpoint(
            name="custom_metric_err", user=admin_user, db=mock_db
        )
    assert exc_info.value.status_code == 403
    assert (
        "Metric cannot be deleted due to active dependencies." in exc_info.value.detail
    )


@pytest.mark.asyncio
async def test_delete_metric_when_db_delete_fails_raises_bad_request_400():
    """Verify delete_metric endpoint raises HTTP 400 when db.delete_metric returns False."""
    mock_db = MagicMock()
    mock_db.metrics.get_metric.return_value = {
        "name": "failing_delete_metric",
        "is_system": False,
    }
    mock_db.metrics.delete_metric.return_value = False

    admin_user = UserContext(
        subject="admin-1", email="admin@example.com", role=Role.ADMIN, groups=[]
    )

    with pytest.raises(HTTPException) as exc_info:
        await delete_metric_endpoint(
            name="failing_delete_metric", user=admin_user, db=mock_db
        )
    assert exc_info.value.status_code == 400
    assert "Failed to delete metric" in exc_info.value.detail


def test_build_metrics_from_config_fallback_known_sets_without_db():
    """Verify build_metrics_from_config resolves retrieval_fast and rag_core without database."""
    mock_llm = MagicMock(spec=DeepEvalBaseLLM)

    # 1. retrieval_fast fallback
    instances_fast = build_metrics_from_config(
        metric_set_name="retrieval_fast", judge_model=mock_llm, db=None
    )
    assert len(instances_fast) >= 4

    # 2. rag_core fallback
    instances_rag = build_metrics_from_config(
        metric_set_name="rag_core", judge_model=mock_llm, db=None
    )
    assert len(instances_rag) >= 3

    # 3. Unknown set fallback to default
    instances_unknown = build_metrics_from_config(
        metric_set_name="completely_unknown_set_xyz", judge_model=mock_llm, db=None
    )
    assert len(instances_unknown) >= 1


def test_metric_sets_and_metrics_get_db_manager_factory():
    """Verify default _get_db_manager dependency provider returns DatabaseManager instance."""
    from deepeval_eval.api.metric_sets import _get_db_manager as get_set_db
    from deepeval_eval.api.metrics import _get_db_manager as get_metric_db

    db1 = get_set_db()
    db2 = get_metric_db()
    assert isinstance(db1, DatabaseManager)
    assert isinstance(db2, DatabaseManager)


@pytest.mark.asyncio
async def test_list_metric_sets_when_enriched_set_is_none_falls_back_to_base_item():
    """Verify list_metric_sets falls back to base item when get_metric_set_with_metrics returns None."""
    user = UserContext(subject="user-1", role=Role.READONLY, email="user@example.com")
    mock_db = MagicMock()
    mock_db.metrics.list_metric_sets.return_value = (
        [
            {
                "name": "custom_set_sparse",
                "display_name": "Sparse Set",
                "is_system": False,
            }
        ],
        1,
    )
    mock_db.metrics.get_metric_set_with_metrics.return_value = (
        None  # Force else branch line 120
    )

    res = await list_metric_sets_endpoint(page=1, limit=50, user=user, db=mock_db)
    assert res.total == 1
    assert len(res.items) == 1
    assert res.items[0].name == "custom_set_sparse"


@pytest.mark.asyncio
async def test_create_metric_set_when_metric_not_found_raises_bad_request_400():
    """Verify create_metric_set raises HTTP 400 when bundling a non-existent metric name."""
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()
    mock_db.metrics.get_metric_set.return_value = None
    mock_db.metrics.get_metric.return_value = None  # metric doesn't exist

    payload = MetricSetCreate(
        name="new_suite",
        display_name="New Suite",
        metrics=[MetricSetItemCreate(metric_name="ghost_metric_1")],
    )

    with pytest.raises(HTTPException) as exc_info:
        await create_metric_set_endpoint(payload, user=admin_user, db=mock_db)
    assert exc_info.value.status_code == 400
    assert "Cannot bundle non-existent metric 'ghost_metric_1'" in exc_info.value.detail


@pytest.mark.asyncio
async def test_delete_metric_set_when_not_found_raises_404_and_when_failed_raises_400():
    """Verify delete_metric_set handles not found (404), failure (400), and system set (403)."""
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()

    # 1. Not found -> 404
    mock_db.metrics.get_metric_set.return_value = None
    with pytest.raises(HTTPException) as exc_info1:
        await delete_metric_set_endpoint("unknown_set", user=admin_user, db=mock_db)
    assert exc_info1.value.status_code == 404

    # 2. Deletion failed -> 400
    mock_db.metrics.get_metric_set.return_value = {
        "name": "fail_set",
        "is_system": False,
    }
    mock_db.metrics.delete_metric_set.return_value = False
    with pytest.raises(HTTPException) as exc_info2:
        await delete_metric_set_endpoint("fail_set", user=admin_user, db=mock_db)
    assert exc_info2.value.status_code == 400
    assert "Failed to delete metric set" in exc_info2.value.detail

    # 3. System set raises ValueError -> 403
    mock_db.metrics.delete_metric_set.side_effect = ValueError(
        "System metric sets cannot be deleted."
    )
    with pytest.raises(HTTPException) as exc_info3:
        await delete_metric_set_endpoint("fail_set", user=admin_user, db=mock_db)
    assert exc_info3.value.status_code == 403
    assert "System metric sets cannot be deleted." in exc_info3.value.detail


@pytest.mark.asyncio
async def test_create_metric_non_g_eval_and_conflict_handling():
    """Verify create_metric rejects non-g_eval types (400) and existing names (409)."""
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()

    # 1. Non-g_eval type -> 400
    payload_builtin = MetricCreate(
        name="custom_builtin",
        display_name="Custom Builtin",
        metric_type="builtin",
    )
    with pytest.raises(HTTPException) as exc_info1:
        await create_metric_endpoint(payload_builtin, user=admin_user, db=mock_db)
    assert exc_info1.value.status_code == 400
    assert "Only 'g_eval' metrics can be dynamically created" in exc_info1.value.detail

    # 2. Existing name conflict -> 409
    payload_geval = MetricCreate(
        name="existing_geval",
        display_name="Existing GEval",
        metric_type="g_eval",
        criteria="Test criteria",
    )
    mock_db.metrics.get_metric.return_value = {"name": "existing_geval"}
    with pytest.raises(HTTPException) as exc_info2:
        await create_metric_endpoint(payload_geval, user=admin_user, db=mock_db)
    assert exc_info2.value.status_code == 409
    assert "already exists" in exc_info2.value.detail


@pytest.mark.asyncio
async def test_update_metric_all_optional_parameter_fallbacks():
    """Verify update_metric preserves existing record fields when update payload has None values."""
    admin_user = UserContext(
        subject="admin-1", role=Role.ADMIN, email="admin@example.com"
    )
    mock_db = MagicMock()
    mock_db.metrics.get_metric.return_value = {
        "name": "full_metric",
        "display_name": "Full Metric",
        "description": "Original description",
        "metric_type": "g_eval",
        "metric_class": None,
        "threshold": 0.6,
        "parameters": {"k": "v"},
        "evaluation_params": ["actual_output"],
        "criteria": "Original criteria",
        "evaluation_steps": ["step 1"],
        "visibility": "team",
        "owner_id": "usr-1",
        "owner_team": "team-a",
        "is_system": False,
    }
    mock_db.metrics.upsert_metric.return_value = {
        "name": "full_metric",
        "display_name": "Full Metric",
        "description": "Original description",
        "metric_type": "g_eval",
        "threshold": 0.6,
        "parameters": {"k": "v"},
        "evaluation_params": ["actual_output"],
        "criteria": "Original criteria",
        "evaluation_steps": ["step 1"],
        "visibility": "team",
        "owner_id": "usr-1",
        "owner_team": "team-a",
        "is_system": False,
    }

    empty_update = MetricUpdate()
    res = await update_metric_endpoint(
        "full_metric", empty_update, user=admin_user, db=mock_db
    )
    assert res.name == "full_metric"
    mock_db.metrics.upsert_metric.assert_called_once_with(
        name="full_metric",
        display_name="Full Metric",
        description="Original description",
        metric_type="g_eval",
        metric_class=None,
        threshold=0.6,
        parameters={"k": "v"},
        evaluation_params=["actual_output"],
        criteria="Original criteria",
        evaluation_steps=["step 1"],
        visibility="team",
        owner_id="usr-1",
        owner_team="team-a",
        is_system=False,
    )
