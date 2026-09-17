"""Tests for the audit side-effect wrapped around `_openfga_check_object`.

Every OpenFGA check RAG makes (search, per-tool, per-datasource, org-admin,
publication-approve) funnels through this one function, so instrumenting it
here covers all of them. Auditing must never change the check's return value
or the exception it raises — see the fail-open/fail-closed assertions below.
Allows are buffered for the rollup flush (record_allow); denials and
PDP-unavailable errors are always written immediately (log_openfga_decision).
"""

from __future__ import annotations

import pytest

from common.models.rbac import Role, UserContext
from server import rbac


def _user(subject: str = "alice-sub", subject_type: str = "user") -> UserContext:
    return UserContext(
        subject=subject,
        subject_type=subject_type,
        email="alice@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )


@pytest.mark.asyncio
async def test_allow_is_buffered_for_the_rollup_not_written_immediately(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: list[dict] = []
    written: list[dict] = []
    monkeypatch.setattr(rbac.audit, "record_allow", lambda **event: recorded.append(event))
    monkeypatch.setattr(rbac.audit, "log_openfga_decision", lambda **event: written.append(event))

    async def _allow(*_a, **_k):
        return True

    monkeypatch.setattr(rbac, "_openfga_raw_check", _allow)

    result = await rbac._openfga_check_object(_user(), "can_read", "data_source", "primary")

    assert result is True
    assert written == []
    assert len(recorded) == 1
    assert recorded[0]["relation"] == "can_read"
    assert recorded[0]["object_type"] == "data_source"
    assert recorded[0]["object_id"] == "primary"
    assert recorded[0]["subject"] == "alice-sub"
    assert recorded[0]["subject_ref"] == "user:alice-sub"


@pytest.mark.asyncio
async def test_deny_is_written_immediately_with_no_capability_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: list[dict] = []
    written: list[dict] = []
    monkeypatch.setattr(rbac.audit, "record_allow", lambda **event: recorded.append(event))
    monkeypatch.setattr(rbac.audit, "log_openfga_decision", lambda **event: written.append(event))

    async def _deny(*_a, **_k):
        return False

    monkeypatch.setattr(rbac, "_openfga_raw_check", _deny)

    result = await rbac._openfga_check_object(_user(), "can_call", "mcp_tool", "custom-tool")

    assert result is False
    assert recorded == []
    assert written[0]["outcome"] == "deny"
    assert written[0]["reason_code"] == "DENY_NO_CAPABILITY"


@pytest.mark.asyncio
async def test_pdp_error_is_written_immediately_and_the_original_exception_still_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    written: list[dict] = []
    monkeypatch.setattr(rbac.audit, "log_openfga_decision", lambda **event: written.append(event))

    async def _raise(*_a, **_k):
        raise RuntimeError("openfga unreachable")

    monkeypatch.setattr(rbac, "_openfga_raw_check", _raise)

    with pytest.raises(RuntimeError, match="openfga unreachable"):
        await rbac._openfga_check_object(_user(), "can_manage", "organization", "caipe")

    assert written[0]["outcome"] == "deny"
    assert written[0]["reason_code"] == "DENY_PDP_UNAVAILABLE"


@pytest.mark.asyncio
async def test_service_account_subject_ref_is_namespaced(monkeypatch: pytest.MonkeyPatch) -> None:
    recorded: list[dict] = []
    monkeypatch.setattr(rbac.audit, "record_allow", lambda **event: recorded.append(event))

    async def _allow(*_a, **_k):
        return True

    monkeypatch.setattr(rbac, "_openfga_raw_check", _allow)

    await rbac._openfga_check_object(
        _user(subject="sa-sub", subject_type="service_account"),
        "can_search",
        "organization",
        "caipe",
    )

    assert recorded[0]["subject_ref"] == "service_account:sa-sub"


@pytest.mark.asyncio
async def test_auditing_never_affects_the_decision_even_if_the_writer_blows_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Audit is a side channel — a broken writer must never affect a decision."""

    def _boom(**_event):
        raise RuntimeError("audit-service down")

    monkeypatch.setattr(rbac.audit, "record_allow", _boom)

    async def _allow(*_a, **_k):
        return True

    monkeypatch.setattr(rbac, "_openfga_raw_check", _allow)

    result = await rbac._openfga_check_object(_user(), "can_read", "data_source", "primary")

    assert result is True


@pytest.mark.asyncio
async def test_full_fidelity_env_disables_allow_buffering(monkeypatch: pytest.MonkeyPatch) -> None:
    recorded: list[dict] = []
    written: list[dict] = []
    monkeypatch.setattr(rbac.audit, "FULL_FIDELITY_ALLOWS", True)
    monkeypatch.setattr(rbac.audit, "record_allow", lambda **event: recorded.append(event))
    monkeypatch.setattr(rbac.audit, "log_openfga_decision", lambda **event: written.append(event))

    async def _allow(*_a, **_k):
        return True

    monkeypatch.setattr(rbac, "_openfga_raw_check", _allow)

    await rbac._openfga_check_object(_user(), "can_read", "data_source", "primary")

    assert recorded == []
    assert written[0]["outcome"] == "allow"
    assert written[0]["reason_code"] == "OK"
