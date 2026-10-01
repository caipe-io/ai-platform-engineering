# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex audit logging."""

from __future__ import annotations

import json
import logging

from ai_platform_engineering.integrations.webex_bot.utils.audit import log_webex_authz_decision


def test_audit_event_hashes_webex_person_id(caplog) -> None:
    person_id = "Y2lzY29zcGFyazovL3BlcnNvbi9BQkMxMjM0"
    with caplog.at_level(logging.INFO, logger="caipe.rbac.audit"):
        event = log_webex_authz_decision(
            tenant_id="default",
            sub=person_id,
            outcome="deny",
            reason_code="WEBEX_USER_NOT_LINKED",
            webex_person_id=person_id,
            webex_space_id="space-abc12345",
        )

    assert event.webex_person_hash is not None
    assert event.webex_person_hash.startswith("sha256:")
    assert person_id not in caplog.text
    record = json.loads(caplog.records[-1].message)
    assert "webex_person_id" not in record
    assert record.get("webex_person_hash") == event.webex_person_hash
