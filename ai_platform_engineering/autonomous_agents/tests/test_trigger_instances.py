"""Tests for ``services.trigger_instances``.

Covers dedup-key derivation precedence (header > signature > none) and
the Mongo-backed claim flow (new insert vs duplicate).
"""

from __future__ import annotations

from typing import Any

import pytest

from autonomous_agents.models import (
    TaskDefinition,
    WebhookTrigger,
)
from autonomous_agents.services.trigger_instances import (
    DedupKey,
    claim_trigger_instance,
    derive_dedup_key,
)


def _make_task(
    task_id: str = "wh-1",
    *,
    secret: str | None = None,
    dedup_header: str | None = None,
) -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name="webhook task",
        agent="dummy-agent",
        prompt="run the thing",
        trigger=WebhookTrigger(secret=secret, dedup_header=dedup_header),
    )


class TestDeriveDedupKey:
    """Header > signature > none precedence rules."""

    def test_header_strategy_used_when_configured_and_present(self):
        """Configured header present in request wins over the signature."""
        task = _make_task(secret="s", dedup_header="X-GitHub-Delivery")
        headers = {"X-GitHub-Delivery": "abc-123", "X-Other": "ignored"}

        result = derive_dedup_key(
            task=task,
            headers=headers,
            verified_signature="sha256=somehexvalue",
        )

        assert result.strategy == "header"
        assert result.key == "wh-1:hdr:abc-123"
        assert result.header_name == "X-GitHub-Delivery"
        assert result.header_value == "abc-123"

    def test_header_strategy_is_case_insensitive(self):
        """Header lookup is case-insensitive."""
        task = _make_task(dedup_header="X-GitHub-Delivery")
        headers = {"x-github-delivery": "lower-cased-id"}

        result = derive_dedup_key(
            task=task, headers=headers, verified_signature=None
        )

        assert result.strategy == "header"
        assert result.key == "wh-1:hdr:lower-cased-id"

    def test_header_configured_but_missing_falls_back_to_signature(self):
        """A missing configured header falls back to the verified signature."""
        task = _make_task(secret="s", dedup_header="X-GitHub-Delivery")
        headers: dict[str, str] = {}

        result = derive_dedup_key(
            task=task,
            headers=headers,
            verified_signature="sha256=deadbeefcafe",
        )

        assert result.strategy == "signature"
        assert result.key == "wh-1:sig:deadbeefcafe"
        assert result.header_name is None
        assert result.header_value is None

    def test_signature_strategy_when_no_dedup_header_configured(self):
        """No dedup_header + HMAC-signed request uses the signature."""
        task = _make_task(secret="s")
        result = derive_dedup_key(
            task=task,
            headers={},
            verified_signature="sha256=abc123",
        )

        assert result.strategy == "signature"
        assert result.key == "wh-1:sig:abc123"

    def test_signature_strategy_strips_unknown_prefix_gracefully(self):
        """Recognised prefixes are stripped; unknown prefixes are kept verbatim."""
        task = _make_task(secret="s")

        r1 = derive_dedup_key(
            task=task, headers={}, verified_signature="sha512=longerhex"
        )
        assert r1.key == "wh-1:sig:longerhex"

        r2 = derive_dedup_key(
            task=task, headers={}, verified_signature="md5=oldhex"
        )
        assert r2.key == "wh-1:sig:md5=oldhex"

    def test_no_strategy_available_returns_none_key(self):
        """No header configured AND no signature returns ``key=None``."""
        task = _make_task()
        result = derive_dedup_key(
            task=task, headers={}, verified_signature=None
        )

        assert result.key is None
        assert result.strategy == "none"


class _FakeMongo:
    """Stand-in mirroring ``MongoService.record_trigger_instance``."""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}

    async def record_trigger_instance(
        self, doc: dict[str, Any]
    ) -> tuple[bool, dict[str, Any] | None]:
        existing = self.rows.get(doc["_id"])
        if existing is not None:
            return False, existing
        self.rows[doc["_id"]] = dict(doc)
        return True, None


class TestClaimTriggerInstance:
    """``claim_trigger_instance`` insert vs duplicate behaviour."""

    async def test_claim_trigger_instance_inserts_new_row(self):
        """A first-time claim succeeds and persists all forensic fields."""
        mongo = _FakeMongo()
        dedup = DedupKey(
            key="wh-1:hdr:abc",
            strategy="header",
            header_name="X-GitHub-Delivery",
            header_value="abc",
        )

        result = await claim_trigger_instance(
            mongo, task_id="wh-1", dedup_key=dedup, body=b'{"hi":1}'
        )

        assert result.claimed is True
        assert result.existing_run_id is None
        assert result.dedup_key == "wh-1:hdr:abc"
        assert result.strategy == "header"

        row = mongo.rows["wh-1:hdr:abc"]
        assert row["task_id"] == "wh-1"
        assert row["dedup_strategy"] == "header"
        assert row["delivery_header_name"] == "X-GitHub-Delivery"
        assert row["delivery_header_value"] == "abc"
        assert row["body_size_bytes"] == len(b'{"hi":1}')
        assert isinstance(row["body_sha256"], str)
        assert len(row["body_sha256"]) == 64
        assert row["run_id"] is None

    async def test_claim_trigger_instance_reports_duplicate_with_existing_run_id(self):
        """A duplicate claim surfaces the original row's run id."""
        mongo = _FakeMongo()
        dedup = DedupKey(key="wh-1:sig:hex", strategy="signature")

        first = await claim_trigger_instance(
            mongo, task_id="wh-1", dedup_key=dedup, body=b"x"
        )
        assert first.claimed is True
        mongo.rows["wh-1:sig:hex"]["run_id"] = "run-abc"

        second = await claim_trigger_instance(
            mongo, task_id="wh-1", dedup_key=dedup, body=b"x"
        )
        assert second.claimed is False
        assert second.existing_run_id == "run-abc"
        assert second.dedup_key == "wh-1:sig:hex"
        assert second.strategy == "signature"

    async def test_claim_trigger_instance_rejects_none_key(self):
        """Callers must not invoke claim with a ``None`` dedup key."""
        mongo = _FakeMongo()
        dedup = DedupKey(key=None, strategy="none")

        with pytest.raises(ValueError, match="no dedup key"):
            await claim_trigger_instance(
                mongo, task_id="wh-1", dedup_key=dedup, body=b""
            )
