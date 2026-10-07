# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Email masking helper for slack-bot logs.

Used by the JIT user creation paths (FR-010, FR-011) and by any other
log line that needs to reference a Slack profile email without writing
the full address to disk. Keeps the domain visible (useful for SIEM
filters and tenant attribution) while obscuring the local part.

Examples::

    mask_email("alice@corp.com")      -> "ali***@corp.com"
    mask_email("a@corp.com")          -> "***@corp.com"
    mask_email("ab@corp.com")         -> "***@corp.com"
    mask_email("malformed-no-at")     -> "***"
    mask_email("")                    -> "***"
    mask_email(None)                  -> "***"

The chosen output shape (first 3 chars + ``***`` + ``@<domain>``) follows
spec FR-010 verbatim. Anyone changing it must update the spec and any
SIEM rules that key off the format.
"""

from __future__ import annotations

from typing import Optional

_MASK = "***"
_PREFIX_KEEP = 3


def mask_email(email: Optional[str]) -> str:
    """Return a privacy-safe rendering of *email* for log emission.

    Never returns ``None`` and never raises, so it is safe to drop into
    any log f-string without a guard.
    """
    if not email or not isinstance(email, str):
        return _MASK

    at_index = email.find("@")
    if at_index <= 0:
        # No local part, or no '@' at all — emit the bare mask so we
        # never accidentally leak a malformed email through the rendered
        # log line.
        return _MASK

    local = email[:at_index]
    domain = email[at_index + 1:]
    if not domain:
        return _MASK

    if len(local) <= _PREFIX_KEEP:
        return f"{_MASK}@{domain}"
    return f"{local[:_PREFIX_KEEP]}{_MASK}@{domain}"
