"""The deployment publisher guards model ownership and immutable selection."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts/ai-platform-engineering/charts/openfga"
SPEC = importlib.util.spec_from_file_location("model_publisher", CHART / "files/publish_model.py")
assert SPEC and SPEC.loader
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)
CORE = json.loads((CHART / "authorization-model.json").read_text())
EXAMPLE = json.loads((ROOT / "ui/examples/agentic-apps/service-only/model.json").read_text())


def composed() -> dict[str, Any]:
    return {**copy.deepcopy(CORE), "type_definitions": [*copy.deepcopy(CORE["type_definitions"]), copy.deepcopy(EXAMPLE)]}


def test_unapproved_modules_and_core_redefinition_fail_before_publication() -> None:
    model = composed()
    with pytest.raises(ValueError, match="approved module"):
        publisher.validate_model(model, CORE, [])
    model["type_definitions"][0]["relations"] = {"backdoor": {"this": {}}}
    with pytest.raises(ValueError, match="host-owned type"):
        publisher.validate_model(model, CORE, ["example-service"])


def test_core_module_provenance_is_allowed_but_policy_extensions_are_not() -> None:
    model = composed()
    model["type_definitions"][0].setdefault("metadata", {})["module"] = "core"
    publisher.validate_model(model, CORE, ["example-service"])
    model["type_definitions"][0].setdefault("relations", {})["backdoor"] = {"this": {}}
    with pytest.raises(ValueError, match="host-owned type"):
        publisher.validate_model(model, CORE, ["example-service"])


def test_relations_named_module_are_policy_not_provenance() -> None:
    baseline = {"schema_version": "1.1", "type_definitions": [{"type": "example",
        "relations": {"module": {"this": {}}},
        "metadata": {"relations": {"module": {"directly_related_user_types": [{"type": "user"}]}}}}]}
    changed = copy.deepcopy(baseline)
    changed["type_definitions"][0]["relations"]["module"] = {"computedUserset": {"relation": "other"}}
    with pytest.raises(ValueError, match="host-owned type"):
        publisher.validate_model(changed, baseline, [])


def test_duplicate_types_and_cross_module_relation_extensions_are_rejected() -> None:
    model = composed()
    model["type_definitions"].append(copy.deepcopy(EXAMPLE))
    with pytest.raises(ValueError, match="Duplicate"):
        publisher.validate_model(model, CORE, ["example-service"])
    model = composed()
    model["type_definitions"][-1]["metadata"]["relations"]["executor"]["module"] = "secondary"
    with pytest.raises(ValueError, match="Cross-module"):
        publisher.validate_model(model, CORE, ["example-service", "secondary"])


def test_publication_reuses_matching_immutable_model_from_later_page() -> None:
    model = composed()
    calls = []

    def request(method: str, path: str, body: dict | None) -> dict:
        calls.append((method, path, body))
        if "continuation_token" not in path:
            return {"authorization_models": [{**model, "id": "current"}], "continuation_token": "next/page"}
        return {"authorization_models": [{**model, "id": "older"}]}

    result = publisher.publish(request, "store", model, CORE, ["example-service"])
    assert result["authorization_model_id"] == "current"
    assert result["sha256"] == publisher.model_hash(model)
    assert result["published"] is False
    assert len(calls) == 2
    assert all(call[0] == "GET" for call in calls)
    assert "next%2Fpage" in calls[-1][1]


def test_app_policy_changes_and_rollbacks_require_targeted_migration_receipt() -> None:
    previous = {**composed(), "id": "current"}
    target = composed()
    target["type_definitions"][-1]["relations"]["can_exec"] = {"computedUserset": {"relation": "owner"}}
    writes = []

    def request(method: str, path: str, body: dict | None) -> dict:
        if method == "GET":
            return {"authorization_models": [previous, {**target, "id": "older-target"}]}
        writes.append(body)
        return {"authorization_model_id": "new"}

    for receipt in [None, {"from_model_id": "wrong", "to_sha256": publisher.model_hash(target), "description": "reviewed"}]:
        with pytest.raises(ValueError, match="migration receipt"):
            publisher.publish(request, "store", target, CORE, ["example-service"], receipt)
    assert not writes
    result = publisher.publish(request, "store", target, CORE, ["example-service"], {
        "from_model_id": "current", "to_sha256": publisher.model_hash(target), "description": "Reviewed tuple migration and rollback",
    })
    assert result["authorization_model_id"] == "older-target"
    assert not writes


def test_native_condition_changes_need_approval_and_hash_includes_id_parameters() -> None:
    model = composed()
    model["conditions"] = {"active": {"name": "active", "expression": "id == 1",
        "parameters": {"id": {"type_name": "TYPE_NAME_INT"}}, "metadata": {"module": "example-service"}}}
    publisher.validate_model(model, CORE, ["example-service"])
    changed = copy.deepcopy(model)
    changed["conditions"]["active"]["parameters"]["id"]["type_name"] = "TYPE_NAME_DOUBLE"
    assert publisher.model_hash(model) != publisher.model_hash(changed)


def test_api_default_values_do_not_create_a_new_model_version() -> None:
    model = composed()
    response_model = copy.deepcopy(model)
    for definition in response_model["type_definitions"]:
        for relation in definition.get("metadata", {}).get("relations", {}).values():
            for ref in relation.get("directly_related_user_types", []):
                ref["condition"] = ""
            relation["module"] = ""
            relation["source_info"] = {"file": ""}
        definition.setdefault("metadata", {}).setdefault("relations", {})["empty_computed_permission"] = {"directly_related_user_types": []}
    response_model["id"] = "existing"
    assert publisher.model_hash(model) == publisher.model_hash(response_model)
    publisher.validate_model(response_model, CORE, ["example-service"])


def test_initializer_pin_preserves_app_modules_without_publishing_bundled_core() -> None:
    model = {**composed(), "id": "selected"}
    calls = []

    def request(method: str, path: str, body: dict | None) -> dict:
        calls.append((method, path))
        assert method == "GET"
        return {"authorization_model": model}

    receipt = publisher.publish(request, "store", CORE, CORE, [], selected_model_id="selected")
    assert receipt["authorization_model_id"] == "selected"
    assert receipt["approved_modules"] == ["example-service"]
    assert receipt["published"] is False
    assert calls == [("GET", "/stores/store/authorization-models/selected")]


def test_bundled_initializer_rejects_a_pin_for_a_different_artifact() -> None:
    model = {**composed(), "id": "selected"}

    def request(method: str, path: str, body: dict | None) -> dict:
        assert method == "GET"
        return {"authorization_model": model}

    with pytest.raises(ValueError, match="does not match the bundled"):
        publisher.publish(request, "store", CORE, CORE, [], selected_model_id="selected", require_exact_model=True)
    assert publisher.publish(request, "store", composed(), CORE, ["example-service"],
                             selected_model_id="selected", require_exact_model=True)["published"] is False


def test_moving_policy_sources_does_not_require_tuple_migration() -> None:
    current = {**composed(), "id": "current"}
    current["type_definitions"][-1]["metadata"]["source_info"] = {"file": "old.fga"}
    target = copy.deepcopy(current)
    target.pop("id")
    target["type_definitions"][-1]["metadata"]["source_info"] = {"file": "new.fga"}

    def request(method: str, path: str, body: dict | None) -> dict:
        if method == "GET":
            return {"authorization_models": [current]}
        return {"authorization_model_id": "new"}

    assert publisher.publish(request, "store", target, CORE, ["example-service"])["published"] is True
