"""Live expansion of agent RAG collections into datasource pins."""

from __future__ import annotations

from pymongo.errors import AutoReconnect

from dynamic_agents.services.mongo import MongoDBService


class _Collection:
    def __init__(self, documents: list[dict] | None = None, error: Exception | None = None):
        self.documents = documents or []
        self.error = error
        self.last_query: dict | None = None

    def find(self, query: dict, _projection: dict) -> list[dict]:
        self.last_query = query
        if self.error:
            raise self.error
        requested = set(query["_id"]["$in"])
        return [document for document in self.documents if document.get("_id") in requested]


class _Database:
    def __init__(self, collection: _Collection):
        self.collection = collection

    def __getitem__(self, name: str) -> _Collection:
        assert name == "rag_collections"
        return self.collection


def _service(collection: _Collection) -> MongoDBService:
    service = object.__new__(MongoDBService)
    service._db = _Database(collection)
    return service


def test_resolve_rag_datasource_ids_unions_live_membership_and_direct_pins() -> None:
    collection = _Collection(
        [
            {"_id": "primary", "source_ids": ["source-a", "source-b"]},
            {"_id": "secondary", "source_ids": ["source-b", "source-c"]},
            {"_id": "unselected", "source_ids": ["source-z"]},
        ]
    )

    result = _service(collection).resolve_rag_datasource_ids(
        ["primary", "secondary", "primary"],
        ["source-direct", "source-a"],
    )

    assert result == ["source-direct", "source-a", "source-b", "source-c"]
    assert collection.last_query == {"_id": {"$in": ["primary", "secondary"]}}


def test_missing_or_deleted_collection_contributes_no_datasources() -> None:
    result = _service(_Collection([])).resolve_rag_datasource_ids(
        ["deleted"],
        ["source-direct"],
    )

    assert result == ["source-direct"]


def test_mongo_outage_fails_closed_to_explicit_direct_pins() -> None:
    result = _service(
        _Collection(error=AutoReconnect("temporarily unavailable"))
    ).resolve_rag_datasource_ids(
        ["primary"],
        ["source-direct"],
    )

    assert result == ["source-direct"]


def test_empty_selection_does_not_touch_mongo() -> None:
    collection = _Collection([{"_id": "primary", "source_ids": ["source-a"]}])

    result = _service(collection).resolve_rag_datasource_ids([], [])

    assert result == []
    assert collection.last_query is None
