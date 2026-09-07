# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by Codex Codex-sonnet-4-6

"""Tests for MongoDB-backed catalog API key hashing."""

from __future__ import annotations

from typing import Any

import pytest

from ai_platform_engineering.skills_middleware import api_keys_store


class FakeCatalogApiKeyCollection:
    def __init__(self) -> None:
        self.documents: list[dict[str, Any]] = []
        self.updates: list[tuple[dict[str, Any], dict[str, Any]]] = []

    def insert_one(self, document: dict[str, Any]) -> None:
        self.documents.append(document)

    def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, Any],
    ) -> dict[str, Any] | None:
        for document in self.documents:
            if all(document.get(key) == value for key, value in query.items()):
                return {
                    key: value
                    for key, value in document.items()
                    if projection.get(key) == 1
                }
        return None

    def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> None:
        self.updates.append((query, update))


@pytest.fixture(autouse=True)
def _catalog_api_key_pepper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAIPE_CATALOG_API_KEY_PEPPER", "test-pepper")


def test_hash_secret_matches_bff_scrypt_vector() -> None:
    assert (
        api_keys_store._hash_secret("sk_testkey1234", "abc123SECRET")
        == "scrypt:v1:zIXXM85RGLR6XvPIUxsA7zxU5EfxqB7KqJDqu_WT_UE"
    )


def test_create_and_verify_catalog_api_key_round_trip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    collection = FakeCatalogApiKeyCollection()
    monkeypatch.setattr(api_keys_store, "_get_collection", lambda: collection)

    full_key, key_id = api_keys_store.create_catalog_api_key("owner-a")
    secret = full_key.removeprefix(f"{key_id}.")
    stored_hash = collection.documents[0]["key_hash"]

    assert stored_hash.startswith("scrypt:v1:")
    assert stored_hash != secret
    assert api_keys_store.verify_catalog_api_key(full_key) == "owner-a"
    assert collection.updates[0][0] == {"key_id": key_id}
    assert "last_used_at" in collection.updates[0][1]["$set"]


def test_verify_catalog_api_key_rejects_wrong_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    collection = FakeCatalogApiKeyCollection()
    monkeypatch.setattr(api_keys_store, "_get_collection", lambda: collection)

    full_key, key_id = api_keys_store.create_catalog_api_key("owner-a")

    assert api_keys_store.verify_catalog_api_key(f"{key_id}.not-the-secret") is None
    assert api_keys_store.verify_catalog_api_key(full_key) == "owner-a"
