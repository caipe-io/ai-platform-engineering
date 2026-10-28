#!/usr/bin/env python3
"""Validate and publish an operator-compiled OpenFGA model; emit an immutable pin.

Compilation and model tests use OpenFGA tooling. This publisher owns deployment
validation, idempotency and provenance, not a second authorization language.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

Model = dict[str, Any]
Request = Callable[[str, str, Model | None], Model]


def normalized(model: Model, *, include_source_info: bool = True) -> Model:
    def clean(value: Any, context: str = "") -> Any:
        if isinstance(value, dict):
            result = {}
            for key, item in sorted(value.items()):
                if key == "source_info" and context == "metadata" and not include_source_info:
                    continue
                item = clean(item, key)
                if key == "metadata" and isinstance(item, dict) and "relations" in item:
                    item["relations"] = {name: info for name, info in item["relations"].items() if info}
                    if not item["relations"]:
                        item.pop("relations")
                if key in {"conditions", "metadata", "relations", "source_info", "directly_related_user_types"} and not item:
                    continue
                if key in {"module", "file", "condition", "object"} and item == "":
                    continue
                if key == "directly_related_user_types":
                    item = sorted(item, key=lambda ref: json.dumps(ref, sort_keys=True))
                result[key] = item
            return result
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value
    result = clean(model)
    result.pop("id", None)
    result["type_definitions"] = sorted(result.get("type_definitions", []), key=lambda item: item["type"])
    return result


def model_hash(model: Model) -> str:
    return hashlib.sha256(json.dumps(normalized(model), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate_model(model: Model, core: Model, modules: list[str]) -> None:
    model = normalized(model)
    core = normalized(core)
    types = model.get("type_definitions", [])
    by_type = {item["type"]: item for item in types}
    if len(types) != len(by_type) or len(modules) != len(set(modules)):
        raise ValueError("Duplicate model type or approved module")
    def policy(value: Any, context: str = "") -> Any:
        if isinstance(value, dict):
            return {key: policy(item, key) for key, item in value.items() if context != "metadata" or key not in {"module", "source_info"}}
        if isinstance(value, list):
            return [policy(item) for item in value]
        return value

    core_types = {item["type"]: item for item in normalized(core)["type_definitions"]}
    for name, expected in core_types.items():
        if name not in by_type or normalized({"type_definitions": policy([by_type[name]])}) != normalized({"type_definitions": policy([expected])}):
            raise ValueError(f"Composed model changes host-owned type: {name}")
    for name, item in by_type.items():
        if name in core_types:
            continue
        module = item.get("metadata", {}).get("module")
        if not module or module not in modules:
            raise ValueError(f"Type has no approved module: {name}")
        for metadata in item.get("metadata", {}).get("relations", {}).values():
            if metadata.get("module", module) != module:
                raise ValueError(f"Cross-module relation extension is not approved: {name}")
    for name, expected in core.get("conditions", {}).items():
        if model.get("conditions", {}).get(name) != expected:
            raise ValueError(f"Composed model changes host-owned condition: {name}")
    for name, condition in model.get("conditions", {}).items():
        if name not in core.get("conditions", {}) and condition.get("metadata", {}).get("module") not in modules:
            raise ValueError(f"Condition has no approved module: {name}")


def publish(request: Request, store_id: str, model: Model, core: Model, modules: list[str],
            migration: Model | None = None, *, selected_model_id: str | None = None,
            require_exact_model: bool = False) -> Model:
    if selected_model_id:
        selected = request("GET", f"/stores/{store_id}/authorization-models/{selected_model_id}", None).get("authorization_model", {})
        if selected.get("id") != selected_model_id:
            raise ValueError("Selected authorization model is unavailable")
        if require_exact_model and model_hash(selected) != model_hash(model):
            raise ValueError("Selected authorization model does not match the bundled host artifact")
        # The explicit deployment pin is approval of this existing immutable model.
        # Verify core compatibility, but never republish/replace its app modules.
        core_names = {item["type"] for item in core["type_definitions"]}
        selected_modules = sorted({item["metadata"]["module"] for item in selected.get("type_definitions", [])
                                   if item["type"] not in core_names and item.get("metadata", {}).get("module")})
        validate_model(selected, core, selected_modules)
        return {"store_id": store_id, "authorization_model_id": selected_model_id,
                "sha256": model_hash(selected), "approved_modules": selected_modules, "published": False}
    validate_model(model, core, modules)
    digest = model_hash(model)
    models: list[Model] = []
    token = ""
    while True:
        page = request("GET", f"/stores/{store_id}/authorization-models?page_size=100" +
                       (f"&continuation_token={urllib.parse.quote(token, safe='')}" if token else ""), None)
        models.extend(page.get("authorization_models", []))
        token = page.get("continuation_token", "")
        if not token:
            break
    # Reinterpreting/removing an app type can invalidate existing grants. It
    # requires a reviewed migration receipt; addition of a new type does not.
    if models:
        current = models[0]
        target_policy = normalized(model, include_source_info=False)
        current_policy = normalized(current, include_source_info=False)
        new_types = {item["type"]: item for item in target_policy["type_definitions"]}
        core_names = {item["type"] for item in core["type_definitions"]}
        changed = any(item["type"] not in core_names and new_types.get(item["type"]) != item
                      for item in current_policy["type_definitions"])
        changed = changed or any(name not in core.get("conditions", {}) and
                                 target_policy.get("conditions", {}).get(name) != condition
                                 for name, condition in current_policy.get("conditions", {}).items())
        if changed and (not migration or migration.get("from_model_id") != current["id"] or
                        migration.get("to_sha256") != digest or not migration.get("description")):
            raise ValueError("Application model change requires a migration receipt for the current model and target hash")
    for previous in models:
        if model_hash(previous) == digest:
            return {"store_id": store_id, "authorization_model_id": previous["id"], "sha256": digest,
                    "approved_modules": sorted(modules), "published": False}
    result = request("POST", f"/stores/{store_id}/authorization-models", model)
    return {"store_id": store_id, "authorization_model_id": result["authorization_model_id"],
            "sha256": digest, "approved_modules": sorted(modules), "published": True}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--core", type=Path, required=True)
    parser.add_argument("--module", action="append", default=[])
    parser.add_argument("--store-id", default=os.environ.get("OPENFGA_STORE_ID"), required=not os.environ.get("OPENFGA_STORE_ID"))
    parser.add_argument("--url", default=os.environ.get("OPENFGA_HTTP", "http://localhost:8080"))
    parser.add_argument("--migration-receipt", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    def request(method: str, path: str, body: Model | None) -> Model:
        pending = urllib.request.Request(args.url.rstrip("/") + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(pending, timeout=60) as response:
            return json.load(response)

    receipt = publish(request, args.store_id, json.loads(args.model.read_text()), json.loads(args.core.read_text()),
                      args.module, json.loads(args.migration_receipt.read_text()) if args.migration_receipt else None)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
