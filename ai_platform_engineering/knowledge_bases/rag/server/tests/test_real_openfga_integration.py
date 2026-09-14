"""Real-OpenFGA integration test for the RAG server's authorization layer.

Every other authorization test in this suite (`test_openfga_team_rebac.py`,
`test_mcp_search_authz.py`, `test_search_authz.py`, ...) monkeypatches the
OpenFGA HTTP call itself, so it verifies the calling code's *logic* given a
stubbed answer, never whether that answer is actually correct against a real
policy decision point.

This file boots an ephemeral, real OpenFGA instance (testcontainers, in-memory
datastore - no Postgres needed), loads the actual production authorization
model, writes real tuples for two distinct users, and calls `rbac.py`'s
functions unmocked. It exists to prove one specific, security-critical
invariant end-to-end: adding a datasource to a RAG collection (the
`parent_collection` edge) never grants access to that datasource's content -
a collection reader only ever sees member datasources they can already read
through their own grant. See `deploy/openfga/model.fga`'s `knowledge_base`
type for the invariant as declared in the model.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Iterator

import httpx
import pytest
from testcontainers.core.container import DockerContainer

from common.models.rbac import UserContext
from server import rbac

REPO_ROOT = Path(__file__).resolve().parents[5]
MODEL_PATH = (
    REPO_ROOT
    / "charts"
    / "ai-platform-engineering"
    / "charts"
    / "openfga"
    / "authorization-model.json"
)
STORE_NAME = "rag-rbac-integration-test"
OPENFGA_PORT = 8080
# Pinned to the same tag the Helm chart deploys
# (charts/ai-platform-engineering/charts/openfga/values.yaml) so a future
# OpenFGA release can't silently change Check/ListObjects/model-validation
# behavior underneath this test.
OPENFGA_IMAGE = "openfga/openfga:v1.15.1"


def _make_user(subject: str) -> UserContext:
    return UserContext(
        subject=subject,
        subject_type="user",
        email=f"{subject}@example.com",
        role="readonly",
        is_authenticated=True,
    )


def _wait_ready(base_url: str) -> None:
    for _ in range(60):
        try:
            if httpx.get(f"{base_url}/stores", timeout=2.0).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(1)
    pytest.fail("OpenFGA test container did not become ready in time")


def _create_store_and_model(base_url: str) -> str:
    with httpx.Client(timeout=30.0) as client:
        store_resp = client.post(f"{base_url}/stores", json={"name": STORE_NAME})
        store_resp.raise_for_status()
        store_id = store_resp.json()["id"]

        model_body = MODEL_PATH.read_text(encoding="utf-8")
        model_resp = client.post(
            f"{base_url}/stores/{store_id}/authorization-models",
            content=model_body,
            headers={"Content-Type": "application/json"},
        )
        model_resp.raise_for_status()
        assert "authorization_model_id" in model_resp.json()
        return store_id


def _write_tuples(base_url: str, store_id: str, tuple_keys: list[dict[str, str]]) -> None:
    with httpx.Client(timeout=30.0) as client:
        response = client.post(
            f"{base_url}/stores/{store_id}/write",
            json={"writes": {"tuple_keys": tuple_keys}},
        )
        response.raise_for_status()


@pytest.fixture(scope="module")
def openfga_base_url() -> Iterator[str]:
    if not MODEL_PATH.exists():
        pytest.fail(f"authorization model not found at {MODEL_PATH}")

    container = DockerContainer(OPENFGA_IMAGE)
    container.with_command("run --datastore-engine memory")
    container.with_exposed_ports(OPENFGA_PORT)
    container.start()
    try:
        host = container.get_container_host_ip()
        port = container.get_exposed_port(OPENFGA_PORT)
        base_url = f"http://{host}:{port}"
        _wait_ready(base_url)
        yield base_url
    finally:
        container.stop()


@pytest.fixture(scope="module")
def openfga_store_id(openfga_base_url: str) -> str:
    return _create_store_and_model(openfga_base_url)


@pytest.fixture(autouse=True)
def _point_rbac_at_test_openfga(
    openfga_base_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every test in this module talks to the real ephemeral OpenFGA, not
    whatever OPENFGA_HTTP/OPENFGA_STORE_NAME the ambient environment has."""
    monkeypatch.setenv("OPENFGA_HTTP", openfga_base_url)
    monkeypatch.setenv("OPENFGA_STORE_NAME", STORE_NAME)
    monkeypatch.delenv("OPENFGA_STORE_ID", raising=False)
    monkeypatch.delenv("CAIPE_UNSAFE_RBAC_BYPASS", raising=False)
    monkeypatch.delenv("RAG_ADMIN_BYPASS_DISABLED", raising=False)


@pytest.fixture(scope="module")
def scenario(openfga_base_url: str, openfga_store_id: str) -> None:
    """Seed the collection-isolation scenario used by every test below.

    Module-scoped and written once: every test in this file reads the same
    seed data (nothing here mutates it), and OpenFGA's `write` endpoint
    rejects re-writing a tuple that already exists.

    - `user:alice` owns knowledge_base/data_source `ds-1`.
    - `data_source:ds-1` inherits read/ingest from `knowledge_base:ds-1`
      via the `parent_kb` edge (spec 2026-06-03 US4).
    - `knowledge_base:ds-1` is a member of `rag_collection:coll-1` via the
      `parent_collection` edge (a curation edge only - grants no access).
    - `user:bob` is a reader of `rag_collection:coll-1` (he may use it as a
      search-scope filter) but has no grant on `ds-1` itself.
    """
    _write_tuples(
        openfga_base_url,
        openfga_store_id,
        [
            {
                "user": "user:alice",
                "relation": "owner",
                "object": "knowledge_base:ds-1",
            },
            {
                "user": "knowledge_base:ds-1",
                "relation": "parent_kb",
                "object": "data_source:ds-1",
            },
            {
                "user": "rag_collection:coll-1",
                "relation": "parent_collection",
                "object": "knowledge_base:ds-1",
            },
            {
                "user": "user:bob",
                "relation": "reader",
                "object": "rag_collection:coll-1",
            },
        ],
    )


@pytest.mark.asyncio
async def test_owner_can_read_their_own_datasource(scenario: None) -> None:
    ids = await rbac.get_accessible_datasource_ids(_make_user("alice"), "read")
    assert ids == ["ds-1"]


@pytest.mark.asyncio
async def test_collection_membership_alone_grants_no_datasource_access(
    scenario: None,
) -> None:
    """`bob` can use `coll-1` as a search-scope filter, but that membership
    must never, by itself, grant him read access to `ds-1`'s content."""
    ids = await rbac.get_accessible_datasource_ids(_make_user("bob"), "read")
    assert ids == []


@pytest.mark.asyncio
async def test_collection_resolves_its_member_datasources_regardless_of_caller(
    scenario: None,
) -> None:
    """Collection membership resolution is caller-independent - it is the
    caller's job (via the accessible-ids intersection above) to narrow this
    down to what they can actually read."""
    ids = await rbac.get_datasource_ids_for_collection("coll-1")
    assert ids == ["ds-1"]


@pytest.mark.asyncio
async def test_bob_cannot_see_ds1_through_the_collection_end_to_end(
    scenario: None,
) -> None:
    """The end-to-end proof: intersecting bob's own accessible datasources
    with the collection's member datasources - exactly what a collection-
    scoped search does - yields nothing. A saved collection filter never
    widens access past the caller's own grants."""
    accessible = set(await rbac.get_accessible_datasource_ids(_make_user("bob"), "read"))
    collection_members = set(await rbac.get_datasource_ids_for_collection("coll-1"))
    assert accessible & collection_members == set()


@pytest.mark.asyncio
async def test_unknown_collection_resolves_to_no_members(scenario: None) -> None:
    ids = await rbac.get_datasource_ids_for_collection("no-such-collection")
    assert ids == []
