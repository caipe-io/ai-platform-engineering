# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
RAG_STACK_VALUES = REPO_ROOT / "charts" / "rag-stack" / "values.yaml"
FORCED_IDENTITY_FIELDS = {"runAsNonRoot", "runAsUser", "runAsGroup"}


def test_stock_milvus_image_does_not_force_incompatible_non_root_identity():
    """The stock image's root-owned 0774 executable must remain executable."""
    values = yaml.safe_load(RAG_STACK_VALUES.read_text())
    milvus = values["milvus"]

    for context_name in ("securityContext", "containerSecurityContext"):
        context = milvus[context_name]
        assert FORCED_IDENTITY_FIELDS.isdisjoint(context), (
            f"milvus.{context_name} must not override the stock image identity"
        )

    container_context = milvus["containerSecurityContext"]
    assert container_context["allowPrivilegeEscalation"] is False
    assert container_context["capabilities"]["drop"] == ["ALL"]
    assert container_context["seccompProfile"]["type"] == "RuntimeDefault"
